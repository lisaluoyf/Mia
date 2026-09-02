export type RoutedIntent =
  | "chat"
  | "image_generate"
  | "image_edit"
  | "vision_qa"
  | "video_generate";

export type PendingMediaIntent = Exclude<RoutedIntent, "chat">;

export type MediaJobType = "image_generate" | "image_edit" | "video_generate";

export type MediaJobStatus =
  | "draft"
  | "queued"
  | "submitting"
  | "submitted"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "expired";

export type ActiveMediaJobStatus = Extract<
  MediaJobStatus,
  "queued" | "submitting" | "submitted" | "in_progress"
>;

export type MediaInputType = "photo" | "document";

export type MediaAccessTokenKind = "share" | "download";

export interface ConversationCoordinates {
  telegramUserId: number;
  chatId: number;
  threadId: number | null;
}

export interface PendingIntentInput extends ConversationCoordinates {
  intent: PendingMediaIntent;
  slots: Record<string, unknown>;
  missingRequired: string[];
  sourceMessageIds: number[];
}

export interface PendingIntent extends PendingIntentInput {
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MediaInput {
  position: number;
  messageId: number;
  fileId: string;
  fileUniqueId: string | null;
  type: MediaInputType;
  mimeType: string | null;
  mediaGroupId: string | null;
}

export interface StoredMediaInput extends MediaInput {
  id: number;
  jobId: number;
  createdAt: string;
}

export interface TelegramMediaReference extends MediaInput {
  chatId: number;
  threadId: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface NewMediaJobInput extends ConversationCoordinates {
  type: MediaJobType;
  idempotencyKey: string;
  requestMessageId: number;
  statusMessageId?: number | null;
  model: string;
  instruction: string;
  options: Record<string, unknown>;
}

export interface MediaJob extends NewMediaJobInput {
  id: number;
  statusMessageId: number | null;
  status: MediaJobStatus;
  upstreamTaskId: string | null;
  progress: number | null;
  resultUrl: string | null;
  resultMimeType: string | null;
  resultTelegramFileId: string | null;
  resultTelegramUniqueId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  deadlineAt: string;
  retentionExpiresAt: string;
}

export interface MediaJobTransitionPatch {
  statusMessageId?: number | null;
  upstreamTaskId?: string | null;
  progress?: number | null;
  resultUrl?: string | null;
  resultMimeType?: string | null;
  resultTelegramFileId?: string | null;
  resultTelegramUniqueId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export type ClaimMediaJobResult =
  | { outcome: "created"; job: MediaJob }
  | { outcome: "existing"; job: MediaJob }
  | { outcome: "limit_reached"; activeCount: number };

export type ClaimMediaDraftResult =
  | { outcome: "claimed"; job: MediaJob }
  | { outcome: "already_claimed"; job: MediaJob }
  | { outcome: "limit_reached"; activeCount: number }
  | { outcome: "expired"; job: MediaJob }
  | { outcome: "not_found" };

export interface ActivePrivateImageInput {
  telegramUserId: number;
  chatId: number;
  messageId: number;
  fileId: string;
  fileUniqueId: string | null;
  type: MediaInputType;
  mimeType: string | null;
  mediaGroupId: string | null;
}

export interface ActivePrivateImage extends ActivePrivateImageInput {
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MediaAccessToken {
  token: string;
  kind: MediaAccessTokenKind;
  jobId: number;
  createdAt: string;
  expiresAt: string;
}

export interface MediaCleanupResult {
  pendingIntentsDeleted: number;
  activeImagesDeleted: number;
  accessTokensDeleted: number;
  jobsExpired: number;
  jobsMediaCleared: number;
  inputRowsDeleted: number;
}

export interface MediaStoreOptions {
  now?: () => Date;
  pendingIntentTtlMs?: number;
  activeImageTtlMs?: number;
  draftTtlMs?: number;
  imageJobTimeoutMs?: number;
  videoJobTimeoutMs?: number;
  retentionTtlMs?: number;
}
