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
  veoModel?: string;
  veoResolution?: string;
  veoAspectRatio?: string;
  veoDurationSeconds?: number;
  veoGenerateAudio?: boolean;
  veoEnhancePrompt?: boolean;
  veoPersonGeneration?: string;
  veoNumberOfVideos?: number;
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
