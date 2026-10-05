/* eslint-disable */
/**
 * The names the backend's functions are called by, `api` for the ones a caller may reach and
 * `internal` for the rest, with the type of each.
 *
 * This file is kept by hand, in step with the modules under `convex/`: each module has two
 * lines here, and a module that is added or removed has its own added or removed with it.
 * @module
 */

import type * as account from "../account.js";
import type * as actions from "../actions.js";
import type * as artifacts from "../artifacts.js";
import type * as bridge from "../bridge.js";
import type * as config from "../config.js";
import type * as content from "../content.js";
import type * as crons from "../crons.js";
import type * as delivery from "../delivery.js";
import type * as displays from "../displays.js";
import type * as http from "../http.js";
import type * as keys from "../keys.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_clash from "../lib/clash.js";
import type * as lib_cookie from "../lib/cookie.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_hash from "../lib/hash.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_log from "../lib/log.js";
import type * as lib_signing from "../lib/signing.js";
import type * as lib_tally from "../lib/tally.js";
import type * as logs from "../logs.js";
import type * as machines from "../machines.js";
import type * as mounts from "../mounts.js";
import type * as network from "../network.js";
import type * as notifications from "../notifications.js";
import type * as projects from "../projects.js";
import type * as publish from "../publish.js";
import type * as push from "../push.js";
import type * as retention from "../retention.js";
import type * as sessions from "../sessions.js";
import type * as state from "../state.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  actions: typeof actions;
  artifacts: typeof artifacts;
  bridge: typeof bridge;
  config: typeof config;
  content: typeof content;
  crons: typeof crons;
  delivery: typeof delivery;
  displays: typeof displays;
  http: typeof http;
  keys: typeof keys;
  "lib/authz": typeof lib_authz;
  "lib/clash": typeof lib_clash;
  "lib/cookie": typeof lib_cookie;
  "lib/errors": typeof lib_errors;
  "lib/hash": typeof lib_hash;
  "lib/limits": typeof lib_limits;
  "lib/log": typeof lib_log;
  "lib/signing": typeof lib_signing;
  "lib/tally": typeof lib_tally;
  logs: typeof logs;
  machines: typeof machines;
  mounts: typeof mounts;
  network: typeof network;
  notifications: typeof notifications;
  projects: typeof projects;
  publish: typeof publish;
  push: typeof push;
  retention: typeof retention;
  sessions: typeof sessions;
  state: typeof state;
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
