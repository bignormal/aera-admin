package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/rbac"
)

func TestParseInvocationAcceptsOnlyInviteSuperAdmin(t *testing.T) {
	parsed, err := parseInvocation([]string{"invite-super-admin", "--email", "admin@example.com", "--display-name", "首位管理员"})
	if err != nil {
		t.Fatalf("parseInvocation() error = %v", err)
	}
	if parsed.Email != "admin@example.com" || parsed.DisplayName != "首位管理员" {
		t.Fatalf("parseInvocation() = %+v", parsed)
	}
	for _, args := range [][]string{
		{},
		{"unknown"},
		{"invite-super-admin", "--email", "admin@example.com"},
		{"invite-super-admin", "--email", "admin@example.com", "--display-name", "管理员", "extra"},
	} {
		if _, err := parseInvocation(args); err == nil {
			t.Errorf("parseInvocation(%q) succeeded", args)
		}
	}
}

func TestExecutePrintsOneTimeActivationURLOnly(t *testing.T) {
	fake := &fakeBootstrapService{result: admin.InvitationResult{ActivationURL: "https://admin.example.test/activate#token=one-time-token"}}
	var output bytes.Buffer
	err := execute(context.Background(), invocation{Email: "admin@example.com", DisplayName: "首位管理员"}, fake, &output)
	if err != nil {
		t.Fatalf("execute() error = %v", err)
	}
	if output.String() != "https://admin.example.test/activate#token=one-time-token\n" {
		t.Fatalf("stdout = %q", output.String())
	}
	if strings.Contains(output.String(), "admin@example.com") || fake.request.Role != rbac.SuperAdmin || fake.request.Reason.Code != "staff_change" {
		t.Fatalf("output/request = %q / %+v", output.String(), fake.request)
	}
}

func TestExecuteDoesNotEchoIdentityOnFailure(t *testing.T) {
	fake := &fakeBootstrapService{err: admin.ErrBootstrapComplete}
	var output bytes.Buffer
	err := execute(context.Background(), invocation{Email: "secret-admin@example.com", DisplayName: "管理员"}, fake, &output)
	if !errors.Is(err, admin.ErrBootstrapComplete) {
		t.Fatalf("execute() error = %v", err)
	}
	if output.Len() != 0 || strings.Contains(err.Error(), "secret-admin@example.com") {
		t.Fatalf("failure output/error leaked identity: %q / %v", output.String(), err)
	}
}

type fakeBootstrapService struct {
	request admin.InviteRequest
	result  admin.InvitationResult
	err     error
}

func (fake *fakeBootstrapService) BootstrapInvite(_ context.Context, request admin.InviteRequest) (admin.InvitationResult, error) {
	fake.request = request
	return fake.result, fake.err
}

var _ bootstrapService = (*fakeBootstrapService)(nil)
