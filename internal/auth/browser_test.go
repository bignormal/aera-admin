package auth

import (
	"net/http"
	"testing"
)

func TestStatusCapturingWriterForwardsOnlyFirstStatus(t *testing.T) {
	underlying := &statusWriterSpy{header: make(http.Header)}
	writer := &statusCapturingWriter{ResponseWriter: underlying}

	writer.WriteHeader(http.StatusCreated)
	writer.WriteHeader(http.StatusInternalServerError)

	if writer.status != http.StatusCreated {
		t.Fatalf("captured status = %d, want %d", writer.status, http.StatusCreated)
	}
	if len(underlying.statuses) != 1 || underlying.statuses[0] != http.StatusCreated {
		t.Fatalf("forwarded statuses = %v, want [%d]", underlying.statuses, http.StatusCreated)
	}
}

type statusWriterSpy struct {
	header   http.Header
	statuses []int
}

func (writer *statusWriterSpy) Header() http.Header {
	return writer.header
}

func (writer *statusWriterSpy) Write(body []byte) (int, error) {
	return len(body), nil
}

func (writer *statusWriterSpy) WriteHeader(status int) {
	writer.statuses = append(writer.statuses, status)
}
