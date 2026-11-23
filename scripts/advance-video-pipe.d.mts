export class VideoResourceError extends Error {
  readonly code: number;
  constructor(code: number, message: string);
  static notFound(): VideoResourceError;
}

export function renderWorkspaceVideo(planPath: string): Promise<{
  artifact: string;
  duration: number;
  width: number;
  height: number;
}>;
export function listWorkspaceVideos(): Promise<{
  resources: Array<{ uri: string; name: string; mimeType: "video/mp4" }>;
}>;
export function readWorkspaceVideo(uri: string): Promise<{
  contents: Array<{ uri: string; mimeType: "video/mp4"; blob: string }>;
}>;
