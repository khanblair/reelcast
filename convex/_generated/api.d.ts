/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_deleteVideo from "../actions/deleteVideo.js";
import type * as actions_generation from "../actions/generation.js";
import type * as actions_metadata from "../actions/metadata.js";
import type * as actions_storage from "../actions/storage.js";
import type * as actions_telegram from "../actions/telegram.js";
import type * as actions_testConnections from "../actions/testConnections.js";
import type * as analytics from "../analytics.js";
import type * as crons from "../crons.js";
import type * as generations from "../generations.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_cloudinary from "../lib/cloudinary.js";
import type * as lib_youtube from "../lib/youtube.js";
import type * as notifications from "../notifications.js";
import type * as scheduled_runGeneration from "../scheduled/runGeneration.js";
import type * as scheduled_runPublish from "../scheduled/runPublish.js";
import type * as settings from "../settings.js";
import type * as testSupport from "../testSupport.js";
import type * as users from "../users.js";
import type * as videos from "../videos.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/deleteVideo": typeof actions_deleteVideo;
  "actions/generation": typeof actions_generation;
  "actions/metadata": typeof actions_metadata;
  "actions/storage": typeof actions_storage;
  "actions/telegram": typeof actions_telegram;
  "actions/testConnections": typeof actions_testConnections;
  analytics: typeof analytics;
  crons: typeof crons;
  generations: typeof generations;
  http: typeof http;
  jobs: typeof jobs;
  "lib/ai": typeof lib_ai;
  "lib/auth": typeof lib_auth;
  "lib/cloudinary": typeof lib_cloudinary;
  "lib/youtube": typeof lib_youtube;
  notifications: typeof notifications;
  "scheduled/runGeneration": typeof scheduled_runGeneration;
  "scheduled/runPublish": typeof scheduled_runPublish;
  settings: typeof settings;
  testSupport: typeof testSupport;
  users: typeof users;
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
