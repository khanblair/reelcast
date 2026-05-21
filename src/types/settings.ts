export interface UserSettings {
  _id: string;
  userId: string;
  defaultPreset?: string;
  defaultQuality?: string;
  defaultCaptions?: boolean;
  defaultBackgroundMusic?: boolean;
  notifyOnGenerationComplete: boolean;
  notifyOnPublishSuccess: boolean;
  notifyOnPublishFailure: boolean;
}

export interface YouTubeConnection {
  connected: boolean;
  channelTitle?: string;
  channelThumbnailUrl?: string;
  connectedAt?: number;
}

export interface TelegramConnection {
  connected: boolean;
  chatId?: string;
  connectedAt?: number;
}
