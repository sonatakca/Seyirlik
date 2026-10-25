/**
 * The import endpoints, as the operations page uses them.
 *
 * The server sends library-relative destinations and no absolute path at all.
 * Nothing here reconstructs one: the roots describe the layout of the
 * operator's disks and were deliberately kept off the wire.
 */
import { ownApiClient } from "../api/ownApi/client";
import type { DriveUploadStatus } from "../server/ownApi/processing/driveUploadStatus";

export interface ImportFile {
  readonly role: string;
  readonly state: string;
  /** Library-relative. There is no absolute form to ask for. */
  readonly destination?: string;
  readonly sizeBytes?: number;
  readonly failureClass?: string;
}

export interface ImportRow {
  readonly id: string;
  readonly state: string;
  readonly strategy?: string;
  readonly target: { kind: string; title: string };
  readonly attempt: number;
  readonly isUpgrade: boolean;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly files: ImportFile[];
  /**
   * The media files' way to Google Drive, read as one. Absent where the
   * importer does not write into a Drive mount.
   */
  readonly driveUpload?: DriveUploadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function listImports(): Promise<ImportRow[]> {
  const { imports } = await ownApiClient.request<{ imports: ImportRow[] }>(
    "/imports",
  );
  return imports;
}

export function retryImport(id: string): Promise<unknown> {
  return ownApiClient.request(`/imports/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: {},
  });
}

/** Asks the server to read the filesystem and settle an unknown outcome. */
export function reconcileImport(id: string): Promise<unknown> {
  return ownApiClient.request(`/imports/${encodeURIComponent(id)}/reconcile`, {
    method: "POST",
    body: {},
  });
}
