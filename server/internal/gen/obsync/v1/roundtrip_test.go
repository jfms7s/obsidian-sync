package obsyncv1_test

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"

	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func TestCommitRequestRoundTrip(t *testing.T) {
	in := &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId:    bytes.Repeat([]byte{1}, 32),
		VersionId: bytes.Repeat([]byte{2}, 16),
		Epoch:     1,
		EncMeta:   []byte("meta"),
		ChunkIds:  [][]byte{bytes.Repeat([]byte{3}, 32)},
		Size:      5,
	}}}
	data, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out := &obsyncv1.CommitRequest{}
	if err := proto.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(in, out) {
		t.Fatalf("round trip changed the message:\n in: %v\nout: %v", in, out)
	}
}

func TestServerFrameOneof(t *testing.T) {
	f := &obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Notify{Notify: &obsyncv1.Notify{VaultId: "v", Seq: 7}}}
	data, err := proto.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var got obsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.GetNotify().GetSeq() != 7 {
		t.Fatalf("seq = %d, want 7", got.GetNotify().GetSeq())
	}
}
