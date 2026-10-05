/* eslint-disable */
/**
 * The names the backend's functions are called by, `api` for the ones a caller may reach and
 * `internal` for the rest.
 *
 * This file is kept by hand, in step with the `convex` package the functions are built with.
 * @module
 */

import { anyApi, componentsGeneric } from "convex/server";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api = anyApi;
export const internal = anyApi;
export const components = componentsGeneric();
