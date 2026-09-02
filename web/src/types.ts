export type Capability = "chat" | "image" | "video";

export interface ModelOption {
  id: string;
  displayName: string;
  vendor: string;
  capability: Capability;
  recommended: boolean;
}

export interface Preferences {
  chatModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
}

export interface TelegramUser {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  photoUrl: string | null;
}

export interface BootstrapData {
  user: TelegramUser;
  apimasterUserId: number;
  models: ModelOption[];
  settings: Preferences;
  unavailable: Capability[];
}
