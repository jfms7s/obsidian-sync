package api

import (
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

func vaultToProto(v store.Vault) *obsyncv1.Vault {
	return &obsyncv1.Vault{
		VaultId:      v.ID,
		EncName:      v.EncName,
		CurrentEpoch: uint32(v.CurrentEpoch),
		Seq:          uint64(v.Seq),
		CreatedAtMs:  v.CreatedAtMs,
		OwnerId:      v.OwnerID,
	}
}

func versionToProto(v store.Version) *obsyncv1.Version {
	return &obsyncv1.Version{
		FileId:        v.FileID,
		VersionId:     v.VersionID,
		BaseVersionId: v.BaseVersionID,
		Epoch:         uint32(v.Epoch),
		EncMeta:       v.EncMeta,
		ChunkIds:      v.ChunkIDs,
		Size:          uint64(v.Size),
		Deleted:       v.Deleted,
		DeviceId:      v.DeviceID,
		CreatedAtMs:   v.CreatedAtMs,
		Seq:           uint64(v.Seq),
	}
}

func versionsToProto(vs []store.Version) *obsyncv1.VersionsResponse {
	resp := &obsyncv1.VersionsResponse{}
	for _, v := range vs {
		resp.Versions = append(resp.Versions, versionToProto(v))
	}
	return resp
}

// commitFromProto converts a commit. A size beyond int64 becomes negative and
// is then rejected by validation.
func commitFromProto(c *obsyncv1.Commit) store.Version {
	return store.Version{
		FileID:        c.FileId,
		VersionID:     c.VersionId,
		BaseVersionID: c.BaseVersionId,
		Epoch:         int(c.Epoch),
		EncMeta:       c.EncMeta,
		ChunkIDs:      c.ChunkIds,
		Size:          int64(c.Size),
		Deleted:       c.Deleted,
	}
}
