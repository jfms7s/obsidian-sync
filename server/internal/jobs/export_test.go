package jobs

import "time"

// SetLeaseRenew makes r renew its pass lease every d instead of every
// passLeaseRenew, so a test need not wait minutes for a renewal.
func SetLeaseRenew(r *Runner, d time.Duration) { r.leaseRenew = d }

// PassLeaseTTL is how long one acquisition or renewal of a pass's lease lasts.
const PassLeaseTTL = passLeaseTTL
