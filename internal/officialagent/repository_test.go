package officialagent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
)

func TestRollbackRepositoryScopesPagesByRole(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newOfficialServiceFixture(t, postgres)
	firstOperator := fixture.seedActor(t, rbac.Operator)
	secondOperator := fixture.seedActor(t, rbac.Operator)
	superAdmin := fixture.seedActor(t, rbac.SuperAdmin)
	auditor := fixture.seedActor(t, rbac.Auditor)
	developer := fixture.seedActor(t, rbac.Developer)

	create := func(actorID int) RollbackApproval {
		requester := firstOperator
		if actorID == 2 {
			requester = secondOperator
		}
		releaseID, versionID := uuid.New(), uuid.New()
		digest := strings.Repeat(string(rune('a'+actorID)), 64)
		fixture.cloud.release = cloudadmin.OfficialRelease{
			ID: releaseID, DefinitionID: uuid.New(), CurrentRevisionID: uuid.New(),
			HeadRevision: int64(actorID), AgentVersionID: uuid.New(),
		}
		fixture.cloud.version = cloudadmin.OfficialVersion{
			ID: versionID, DefinitionID: fixture.cloud.release.DefinitionID, ContentDigest: digest,
		}
		approval, err := fixture.service.RequestRollback(context.Background(), requester, RollbackRequest{
			ReleaseID: releaseID, TargetVersionID: versionID, TargetReleaseRevisionID: uuid.New(),
			ExpectedHeadRevision: int64(actorID), TargetDigest: digest,
			Reason: officialReason(requester, "official_release_rollback"),
		})
		if err != nil {
			t.Fatal(err)
		}
		fixture.now = fixture.now.AddDate(0, 0, 1)
		return approval
	}
	first := create(1)
	second := create(2)

	page, err := fixture.service.ListRollbacks(context.Background(), firstOperator, ListFilter{View: "all", Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != first.ID || page.NextCursor != "" {
		t.Fatalf("Operator page = %+v, %v", page, err)
	}
	page, err = fixture.service.ListRollbacks(context.Background(), superAdmin, ListFilter{View: "all", Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != second.ID || page.NextCursor == "" {
		t.Fatalf("Super Admin first page = %+v, %v", page, err)
	}
	next, err := fixture.service.ListRollbacks(context.Background(), superAdmin, ListFilter{View: "all", Cursor: page.NextCursor, Limit: 1})
	if err != nil || len(next.Items) != 1 || next.Items[0].ID != first.ID {
		t.Fatalf("Super Admin next page = %+v, %v", next, err)
	}
	page, err = fixture.service.ListRollbacks(context.Background(), auditor, ListFilter{View: "mine", Limit: 10})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("Auditor page = %+v, %v", page, err)
	}
	if _, err := fixture.service.ListRollbacks(context.Background(), developer, ListFilter{View: "all", Limit: 10}); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("Developer ListRollbacks() error = %v", err)
	}
}
