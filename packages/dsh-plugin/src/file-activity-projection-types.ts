export const FILE_ACTIVITY_PROJECTION_KEY = "ohStoryFileActivity";

export interface ProjectedFileCall {
  readonly callId: string;
  readonly name: string;
  readonly argsRaw: string;
  readonly slot: string;
}

export interface FileActivityProjection {
  readonly calls: readonly ProjectedFileCall[];
}
