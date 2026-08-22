// A clipboard for the file browsers, shared across panes and tabs so you
// can copy in one and paste in another view of the same host or bucket.
//
// It holds references, not bytes: the copy happens on the server when you
// paste (cp/mv over SSH, CopyObject for S3), so nothing travels via this
// machine. That is also why a paste is only offered back into the same
// session or bucket — moving between two different hosts would mean a
// download and re-upload, which this does not do.

export interface FileClip {
  kind: "sftp" | "s3";
  /** SSH session id, for kind "sftp" */
  sessionId?: number;
  /** storage id and bucket, for kind "s3" */
  storageId?: string;
  bucket?: string | null;
  /** absolute paths (sftp) or keys, a prefix ending in "/" (s3) */
  items: string[];
  mode: "copy" | "cut";
}

let clip: FileClip | null = null;

export function setClip(next: FileClip): void {
  clip = next;
}

export function getClip(): FileClip | null {
  return clip;
}

export function clearClip(): void {
  clip = null;
}

/** Whether this clipboard can be pasted into an SFTP session. */
export function clipForSession(sessionId: number): FileClip | null {
  return clip && clip.kind === "sftp" && clip.sessionId === sessionId
    ? clip
    : null;
}

/** Whether this clipboard can be pasted into an S3 bucket. */
export function clipForBucket(
  storageId: string,
  bucket: string | null,
): FileClip | null {
  return clip &&
    clip.kind === "s3" &&
    clip.storageId === storageId &&
    clip.bucket === bucket
    ? clip
    : null;
}

/** "3 items" / the single name, for menu labels and notices. */
export function clipLabel(c: FileClip): string {
  if (c.items.length !== 1) return `${c.items.length} items`;
  const only = c.items[0].replace(/\/$/, "");
  return only.slice(only.lastIndexOf("/") + 1) || only;
}
