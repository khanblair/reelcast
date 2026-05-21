/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_publish from "../actions/publish.js";
import type * as actions_storage from "../actions/storage.js";
import type * as actions_telegram from "../actions/telegram.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as lib_auth from "../lib/auth.js";
import type * as scheduled_runGeneration from "../scheduled/runGeneration.js";
import type * as scheduled_runPublish from "../scheduled/runPublish.js";
import type * as settings from "../settings.js";
import type * as users from "../users.js";
import type * as videos from "../videos.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/publish": typeof actions_publish;
  "actions/storage": typeof actions_storage;
  "actions/telegram": typeof actions_telegram;
  http: typeof http;
  jobs: typeof jobs;
  "lib/auth": typeof lib_auth;
  "scheduled/runGeneration": typeof scheduled_runGeneration;
  "scheduled/runPublish": typeof scheduled_runPublish;
  settings: typeof settings;
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
