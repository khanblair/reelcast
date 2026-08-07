/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_aiAssistant from "../actions/aiAssistant.js";
import type * as actions_autoPublish from "../actions/autoPublish.js";
import type * as actions_backfillDurations from "../actions/backfillDurations.js";
import type * as actions_contentIntelligence from "../actions/contentIntelligence.js";
import type * as actions_deleteVideo from "../actions/deleteVideo.js";
import type * as actions_email from "../actions/email.js";
import type * as actions_generation from "../actions/generation.js";
import type * as actions_metadata from "../actions/metadata.js";
import type * as actions_oauthHealthCheck from "../actions/oauthHealthCheck.js";
import type * as actions_publishNow from "../actions/publishNow.js";
import type * as actions_storage from "../actions/storage.js";
import type * as actions_telegram from "../actions/telegram.js";
import type * as actions_testConnections from "../actions/testConnections.js";
import type * as actions_youtubeAnalytics from "../actions/youtubeAnalytics.js";
import type * as admin_jobs from "../admin/jobs.js";
import type * as admin_notifications from "../admin/notifications.js";
import type * as admin_platformSettings from "../admin/platformSettings.js";
import type * as admin_quota from "../admin/quota.js";
import type * as admin_stats from "../admin/stats.js";
import type * as admin_storage from "../admin/storage.js";
import type * as admin_testApiKeys from "../admin/testApiKeys.js";
import type * as admin_usageLedger from "../admin/usageLedger.js";
import type * as admin_users from "../admin/users.js";
import type * as admin_videos from "../admin/videos.js";
import type * as aiMessages from "../aiMessages.js";
import type * as aiSessions from "../aiSessions.js";
import type * as analytics from "../analytics.js";
import type * as crons from "../crons.js";
import type * as generations from "../generations.js";
import type * as http from "../http.js";
import type * as ideas from "../ideas.js";
import type * as jobs from "../jobs.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_cloudinary from "../lib/cloudinary.js";
import type * as lib_youtube from "../lib/youtube.js";
import type * as notifications from "../notifications.js";
import type * as queue from "../queue.js";
import type * as scheduled_runGeneration from "../scheduled/runGeneration.js";
import type * as scheduled_runPublish from "../scheduled/runPublish.js";
import type * as settings from "../settings.js";
import type * as testSupport from "../testSupport.js";
import type * as usageLedger from "../usageLedger.js";
import type * as users from "../users.js";
import type * as videoAnalytics from "../videoAnalytics.js";
import type * as videos from "../videos.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/aiAssistant": typeof actions_aiAssistant;
  "actions/autoPublish": typeof actions_autoPublish;
  "actions/backfillDurations": typeof actions_backfillDurations;
  "actions/contentIntelligence": typeof actions_contentIntelligence;
  "actions/deleteVideo": typeof actions_deleteVideo;
  "actions/email": typeof actions_email;
  "actions/generation": typeof actions_generation;
  "actions/metadata": typeof actions_metadata;
  "actions/oauthHealthCheck": typeof actions_oauthHealthCheck;
  "actions/publishNow": typeof actions_publishNow;
  "actions/storage": typeof actions_storage;
  "actions/telegram": typeof actions_telegram;
  "actions/testConnections": typeof actions_testConnections;
  "actions/youtubeAnalytics": typeof actions_youtubeAnalytics;
  "admin/jobs": typeof admin_jobs;
  "admin/notifications": typeof admin_notifications;
  "admin/platformSettings": typeof admin_platformSettings;
  "admin/quota": typeof admin_quota;
  "admin/stats": typeof admin_stats;
  "admin/storage": typeof admin_storage;
  "admin/testApiKeys": typeof admin_testApiKeys;
  "admin/usageLedger": typeof admin_usageLedger;
  "admin/users": typeof admin_users;
  "admin/videos": typeof admin_videos;
  aiMessages: typeof aiMessages;
  aiSessions: typeof aiSessions;
  analytics: typeof analytics;
  crons: typeof crons;
  generations: typeof generations;
  http: typeof http;
  ideas: typeof ideas;
  jobs: typeof jobs;
  "lib/ai": typeof lib_ai;
  "lib/auth": typeof lib_auth;
  "lib/cloudinary": typeof lib_cloudinary;
  "lib/youtube": typeof lib_youtube;
  notifications: typeof notifications;
  queue: typeof queue;
  "scheduled/runGeneration": typeof scheduled_runGeneration;
  "scheduled/runPublish": typeof scheduled_runPublish;
  settings: typeof settings;
  testSupport: typeof testSupport;
  usageLedger: typeof usageLedger;
  users: typeof users;
  videoAnalytics: typeof videoAnalytics;
  videos: typeof videos;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
