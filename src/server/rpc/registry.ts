/** The browser-callable API. Mirrors the Convex `api.*` shape so call sites port mechanically. */
import * as users from "../modules/users";
import * as settings from "../modules/settings";
import * as videos from "../modules/videos";
import * as jobs from "../modules/jobs";
import * as queue from "../modules/queue";
import * as generations from "../modules/generations";
import * as ideas from "../modules/ideas";
import * as scheduling from "../modules/scheduling";
import * as notifications from "../modules/notifications";
import * as aiSessions from "../modules/aiSessions";
import * as aiMessages from "../modules/aiMessages";
import * as analytics from "../modules/analytics";
import * as videoAnalytics from "../modules/videoAnalytics";
import * as youtubeChannels from "../modules/youtubeChannels";
import * as usageLedger from "../modules/usageLedger";
import * as contact from "../modules/contact";
import * as billing from "../modules/billing";
import * as a_aiAssistant from "../modules/actions/aiAssistant";
import * as a_backfillDurations from "../modules/actions/backfillDurations";
import * as a_contentIntelligence from "../modules/actions/contentIntelligence";
import * as a_deleteVideo from "../modules/actions/deleteVideo";
import * as a_generateCaptions from "../modules/actions/generateCaptions";
import * as a_generateThumbnail from "../modules/actions/generateThumbnail";
import * as a_metadata from "../modules/actions/metadata";
import * as a_oauthHealthCheck from "../modules/actions/oauthHealthCheck";
import * as a_publishNow from "../modules/actions/publishNow";
import * as a_storageHealth from "../modules/actions/storageHealth";
import * as a_testConnections from "../modules/actions/testConnections";
import * as a_youtubeAnalytics from "../modules/actions/youtubeAnalytics";
import * as ad_billing from "../modules/admin/billing";
import * as ad_contact from "../modules/admin/contact";
import * as ad_health from "../modules/admin/health";
import * as ad_jobs from "../modules/admin/jobs";
import * as ad_notifications from "../modules/admin/notifications";
import * as ad_platformSettings from "../modules/admin/platformSettings";
import * as ad_quota from "../modules/admin/quota";
import * as ad_stats from "../modules/admin/stats";
import * as ad_storage from "../modules/admin/storage";
import * as ad_testApiKeys from "../modules/admin/testApiKeys";
import * as ad_usageLedger from "../modules/admin/usageLedger";
import * as ad_users from "../modules/admin/users";
import * as ad_videos from "../modules/admin/videos";

export const api = {
  users,
  settings,
  videos,
  jobs,
  queue,
  generations,
  ideas,
  scheduling,
  notifications,
  aiSessions,
  aiMessages,
  analytics,
  videoAnalytics,
  youtubeChannels,
  usageLedger,
  contact,
  billing,
  actions: {
    aiAssistant: a_aiAssistant,
    backfillDurations: a_backfillDurations,
    contentIntelligence: a_contentIntelligence,
    deleteVideo: a_deleteVideo,
    generateCaptions: a_generateCaptions,
    generateThumbnail: a_generateThumbnail,
    metadata: a_metadata,
    oauthHealthCheck: a_oauthHealthCheck,
    publishNow: a_publishNow,
    storageHealth: a_storageHealth,
    testConnections: a_testConnections,
    youtubeAnalytics: a_youtubeAnalytics,
  },
  admin: {
    billing: ad_billing,
    contact: ad_contact,
    health: ad_health,
    jobs: ad_jobs,
    notifications: ad_notifications,
    platformSettings: ad_platformSettings,
    quota: ad_quota,
    stats: ad_stats,
    storage: ad_storage,
    testApiKeys: ad_testApiKeys,
    usageLedger: ad_usageLedger,
    users: ad_users,
    videos: ad_videos,
  },
} as const;

export type Api = typeof api;
