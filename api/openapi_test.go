package api_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestCloudAdminContractMatchesProviderWhenConfigured(t *testing.T) {
	cloudRepo := os.Getenv("AERA_ADMIN_TEST_CLOUD_REPO")
	if cloudRepo == "" {
		t.Skip("AERA_ADMIN_TEST_CLOUD_REPO is not configured")
	}
	consumer, err := os.ReadFile("openapi/cloud-admin-client.yaml")
	if err != nil {
		t.Fatalf("read Cloud Admin consumer contract: %v", err)
	}
	provider, err := os.ReadFile(filepath.Join(cloudRepo, "api", "openapi", "internal-admin.yaml"))
	if err != nil {
		t.Fatalf("read Cloud Admin provider contract: %v", err)
	}
	if !bytes.Equal(consumer, provider) {
		t.Fatal("Cloud Internal Admin provider and consumer contracts differ")
	}
}

func TestOpenAPIContract(t *testing.T) {
	encoded, err := os.ReadFile("openapi/admin.yaml")
	if err != nil {
		t.Fatal("read Admin OpenAPI contract")
	}
	var document map[string]any
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		t.Fatal("parse Admin OpenAPI contract")
	}
	if document["openapi"] != "3.1.0" {
		t.Fatalf("OpenAPI version = %v, want 3.1.0", document["openapi"])
	}
	paths := object(t, document["paths"], "paths")
	if len(paths) != 32 {
		t.Fatalf("OpenAPI path count = %d, want 32", len(paths))
	}
	operationIDs := make(map[string]string)
	for path, rawPathItem := range paths {
		if !strings.HasPrefix(path, "/") {
			t.Fatalf("OpenAPI path %q is not absolute", path)
		}
		pathItem := object(t, rawPathItem, path)
		for method, rawOperation := range pathItem {
			if method != "get" && method != "post" && method != "put" && method != "delete" && method != "patch" {
				t.Fatalf("OpenAPI path %s contains unsupported key %q", path, method)
			}
			operation := object(t, rawOperation, path+" "+method)
			operationID, ok := operation["operationId"].(string)
			if !ok || operationID == "" {
				t.Fatalf("OpenAPI operation %s %s has no operationId", method, path)
			}
			if previous, duplicate := operationIDs[operationID]; duplicate {
				t.Fatalf("OpenAPI operationId %q is shared by %s and %s %s", operationID, previous, method, path)
			}
			operationIDs[operationID] = method + " " + path
			if len(object(t, operation["responses"], path+" responses")) == 0 {
				t.Fatalf("OpenAPI operation %s %s has no responses", method, path)
			}
		}
	}

	for _, path := range []string{
		"/admin-users/invitations",
		"/admin-users/{adminID}/suspend",
		"/admin-users/{adminID}/sessions/revoke",
		"/admin-users/{adminID}/totp/reset",
	} {
		operation := object(t, object(t, paths[path], path)["post"], path+" post")
		assertSessionAndCSRF(t, operation, path)
		responses := object(t, operation["responses"], path+" responses")
		if _, ok := responses["500"]; !ok {
			t.Fatalf("OpenAPI operation POST %s does not declare internal failures", path)
		}
	}
	roleOperation := object(t, object(t, paths["/admin-users/{adminID}/role"], "role path")["put"], "role put")
	assertSessionAndCSRF(t, roleOperation, "/admin-users/{adminID}/role")

	walkReferences(t, document, document, "#")
}

func TestAuditBrowserContractUsesSafeCursorProjection(t *testing.T) {
	raw := readContract(t, "openapi/admin.yaml")
	if !strings.Contains(raw, "operationId: listAuditEvents") {
		t.Fatal("audit query operation is missing")
	}
	var document map[string]any
	if err := yaml.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatal(err)
	}
	paths := object(t, document["paths"], "paths")
	operation := object(t, object(t, paths["/audit-events"], "audit path")["get"], "audit get")
	security := operation["security"]
	if security == nil {
		t.Fatal("audit query does not require administrator session security")
	}
	schemas := object(t, object(t, document["components"], "components")["schemas"], "schemas")
	properties := object(t, object(t, schemas["AuditEvent"], "AuditEvent")["properties"], "AuditEvent properties")
	for _, forbidden := range []string{"source_ip_hmac", "user_agent", "previous_hash", "event_hash", "email", "phone"} {
		if _, present := properties[forbidden]; present {
			t.Errorf("AuditEvent exposes %s", forbidden)
		}
	}
}

func TestSettingsBrowserContractDeclaresRBACStepUpAndStableMutations(t *testing.T) {
	raw := readContract(t, "openapi/admin.yaml")
	for _, operationID := range []string{
		"getSystemSettings", "updateSystemSecurityPolicy", "listSystemReasonCodes",
		"createSystemReasonCode", "updateSystemReasonCode",
	} {
		if !strings.Contains(raw, "operationId: "+operationID) {
			t.Errorf("missing settings operation %s", operationID)
		}
	}
	for _, code := range []string{
		"SETTINGS_REVISION_CONFLICT", "SETTINGS_POLICY_INVALID", "REASON_CODE_ALREADY_EXISTS",
		"REASON_CODE_NOT_FOUND", "REASON_CODE_INACTIVE", "REASON_CODE_CATEGORY_MISMATCH",
		"REASON_CODE_LAST_ACTIVE", "REASON_CODE_PROTECTED", "IDEMPOTENCY_KEY_REUSED",
	} {
		if !strings.Contains(raw, code) {
			t.Errorf("missing stable settings error %s", code)
		}
	}

	var document map[string]any
	if err := yaml.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatal(err)
	}
	paths := object(t, document["paths"], "paths")
	for path, method := range map[string]string{
		"/system/settings/security-policy": "put",
		"/system/reason-codes":             "post",
		"/system/reason-codes/{code}":      "put",
	} {
		operation := object(t, object(t, paths[path], path)[method], path+" "+method)
		assertSessionAndCSRF(t, operation, path)
		parameters, ok := operation["parameters"].([]any)
		if !ok || len(parameters) == 0 {
			t.Fatalf("settings mutation %s has no Idempotency-Key parameter", path)
		}
	}
	for _, path := range []string{"/system/settings", "/system/reason-codes"} {
		operation := object(t, object(t, paths[path], path)["get"], path+" get")
		if operation["security"] == nil {
			t.Fatalf("settings read %s has no session security", path)
		}
	}

	schemas := object(t, object(t, document["components"], "components")["schemas"], "schemas")
	policyProperties := object(t, object(t, schemas["SecurityPolicy"], "SecurityPolicy")["properties"], "SecurityPolicy properties")
	for _, field := range []string{"session_idle_minutes", "session_absolute_hours", "audit_retention_days", "revision", "updated_by_admin_id", "updated_at"} {
		if _, ok := policyProperties[field]; !ok {
			t.Errorf("SecurityPolicy is missing %s", field)
		}
	}
	reasonProperties := object(t, object(t, schemas["ReasonCode"], "ReasonCode")["properties"], "ReasonCode properties")
	for _, forbidden := range []string{"email", "phone", "source_ip_hmac", "user_agent"} {
		if _, ok := reasonProperties[forbidden]; ok {
			t.Errorf("ReasonCode exposes %s", forbidden)
		}
	}
}

func readContract(t *testing.T, name string) string {
	t.Helper()
	encoded, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(encoded)
}

func TestCloudBrowserContractHasEverySecuredOperation(t *testing.T) {
	raw := readContract(t, "openapi/admin.yaml")
	for _, operationID := range []string{
		"listCloudUsers", "lookupCloudUser", "getCloudUser", "listCloudUserDevices",
		"listCloudUserSessions", "revokeCloudDevice", "revokeCloudSession",
		"createApprovalRequest", "listApprovalRequests", "getApprovalRequest",
		"approveApprovalRequest", "rejectApprovalRequest", "cancelApprovalRequest",
		"getAdminOperation", "getAdminSystemHealth",
	} {
		if !strings.Contains(raw, "operationId: "+operationID) {
			t.Errorf("missing operation %s", operationID)
		}
	}
	var document map[string]any
	if err := yaml.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatal(err)
	}
	paths := object(t, document["paths"], "paths")
	for _, path := range []string{
		"/cloud-users/lookup", "/cloud-devices/{deviceID}/revoke", "/cloud-sessions/{sessionID}/revoke",
		"/approval-requests", "/approval-requests/{approvalID}/approve",
		"/approval-requests/{approvalID}/reject", "/approval-requests/{approvalID}/cancel",
	} {
		operation := object(t, object(t, paths[path], path)["post"], path+" post")
		assertSessionAndCSRF(t, operation, path)
	}
}

func TestExactIdentityExistsOnlyInLookupRequestBody(t *testing.T) {
	var document map[string]any
	raw := readContract(t, "openapi/admin.yaml")
	if err := yaml.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatal(err)
	}
	paths := object(t, document["paths"], "paths")
	for path, value := range paths {
		if strings.Contains(strings.ToLower(path), "email") || strings.Contains(strings.ToLower(path), "phone") {
			t.Errorf("identity field appears in path %s", path)
		}
		pathItem := object(t, value, path)
		for method, operationValue := range pathItem {
			operation, ok := operationValue.(map[string]any)
			if !ok {
				continue
			}
			parameters, _ := operation["parameters"].([]any)
			for _, parameterValue := range parameters {
				parameter, ok := parameterValue.(map[string]any)
				if !ok {
					continue
				}
				name, _ := parameter["name"].(string)
				if strings.EqualFold(name, "email") || strings.EqualFold(name, "phone") || strings.EqualFold(name, "value") {
					t.Errorf("identity parameter %s appears on %s %s", name, method, path)
				}
			}
		}
	}
	if !strings.Contains(raw, "/cloud-users/lookup:") ||
		!strings.Contains(raw, "$ref: '#/components/schemas/IdentityLookupRequest'") {
		t.Fatal("POST lookup request body is missing")
	}
}

func TestCloudConsumerContract(t *testing.T) {
	encoded, err := os.ReadFile("openapi/cloud-admin-client.yaml")
	if err != nil {
		t.Fatal("read Cloud Admin consumer contract")
	}
	var document map[string]any
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		t.Fatal("parse Cloud Admin consumer contract")
	}
	if document["openapi"] != "3.1.0" {
		t.Fatalf("Cloud OpenAPI version = %v, want 3.1.0", document["openapi"])
	}
	paths := object(t, document["paths"], "Cloud paths")
	if len(paths) != 11 {
		t.Fatalf("Cloud path count = %d, want 11", len(paths))
	}
	raw := string(encoded)
	for _, operationID := range []string{
		"getCloudAdminHealth", "listCloudUsers", "lookupCloudUser", "getCloudUser",
		"listCloudUserDevices", "listCloudUserSessions", "revokeCloudDevice",
		"revokeCloudSession", "disableCloudUser", "enableCloudUser", "getCloudAdminOperation",
	} {
		if !strings.Contains(raw, "operationId: "+operationID) {
			t.Errorf("missing %s", operationID)
		}
	}
	components := object(t, document["components"], "Cloud components")
	schemes := object(t, components["securitySchemes"], "Cloud security schemes")
	if object(t, schemes["mutualTLS"], "mutualTLS")["type"] != "mutualTLS" ||
		object(t, schemes["serviceJWT"], "serviceJWT")["scheme"] != "bearer" {
		t.Fatal("Cloud contract does not require mTLS plus service JWT")
	}
	schemas := object(t, components["schemas"], "Cloud schemas")
	for _, schemaName := range []string{"User", "Device", "Session", "Operation"} {
		properties := object(t, object(t, schemas[schemaName], schemaName)["properties"], schemaName+" properties")
		for _, forbidden := range []string{"email", "phone", "identity_ciphertext", "token", "public_key"} {
			if _, present := properties[forbidden]; present {
				t.Errorf("%s exposes %s", schemaName, forbidden)
			}
		}
	}
	walkReferences(t, document, document, "#")
}

func assertSessionAndCSRF(t *testing.T, operation map[string]any, path string) {
	t.Helper()
	security, ok := operation["security"].([]any)
	if !ok || len(security) != 1 {
		t.Fatalf("OpenAPI operation %s has an invalid security requirement", path)
	}
	requirement := object(t, security[0], path+" security")
	if _, session := requirement["adminSession"]; !session {
		t.Fatalf("OpenAPI operation %s does not require an administrator session", path)
	}
	if _, csrf := requirement["csrfToken"]; !csrf {
		t.Fatalf("OpenAPI operation %s does not require CSRF", path)
	}
}

func walkReferences(t *testing.T, root map[string]any, value any, location string) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		if rawReference, ok := typed["$ref"]; ok {
			reference, stringReference := rawReference.(string)
			if !stringReference || !strings.HasPrefix(reference, "#/") || resolveReference(root, reference) == nil {
				t.Fatalf("OpenAPI reference at %s is unresolved", location)
			}
		}
		for key, child := range typed {
			walkReferences(t, root, child, location+"/"+key)
		}
	case []any:
		for _, child := range typed {
			walkReferences(t, root, child, location)
		}
	}
}

func resolveReference(root map[string]any, reference string) any {
	var current any = root
	for _, segment := range strings.Split(strings.TrimPrefix(reference, "#/"), "/") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = object[strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")]
		if !ok {
			return nil
		}
	}
	return current
}

func object(t *testing.T, value any, location string) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("OpenAPI %s is not an object", location)
	}
	return object
}
