export interface VideoMetrics {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  views: number;
  watchTimeMinutes: number;
  likes: number;
  comments: number;
  subscribersGained: number;
  publishedAt: number;
}

export interface ChannelMetrics {
  totalViews: number;
  totalWatchTimeMinutes: number;
  totalLikes: number;
  totalComments: number;
  totalSubscribersGained: number;
  videoCount: number;
}

export interface AnalyticsPeriod {
  start: Date;
  end: Date;
}

export interface AnalyticsResponse {
  channel: ChannelMetrics;
  videos: VideoMetrics[];
}
