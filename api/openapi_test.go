package api_test

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

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
	if len(paths) != 13 {
		t.Fatalf("OpenAPI path count = %d, want 13", len(paths))
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
