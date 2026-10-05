// Upload stages a user can still cancel: not started, sending, or being processed on the server.
export const CANCELLABLE = ["pending", "waiting", "uploading", "queued", "processing", "indexing"];
// Stages tracked by polling the server.
export const TRACKED = ["queued", "processing", "indexing"];
