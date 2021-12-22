// /source/lib.ts
// The option parser and rate limiting middleware

import Express from 'express'

import {
	Options,
	AugmentedRequest,
	RateLimitRequestHandler,
	LegacyStore,
	Store,
	IncrementResponse,
} from './types.js'
import MemoryStore from './memory-store.js'

/**
 * Type guard to check if a store is callbacky store.
 *
 * @param store {LegacyStore | Store} - The store to check
 *
 * @return {boolean} - Whether the store is a callbacky store
 */
const isLegacyStore = (store: LegacyStore | Store): store is LegacyStore =>
	typeof (store as LegacyStore).incr === 'function'

/**
 * Converts a callbacky store to the promisified version.
 *
 * @param store {LegacyStore | Store} - The callbacky store or even a modern store
 *
 * @returns {Store} - The promisified version of the store
 */
const promisifyStore = (passedStore: LegacyStore | Store): Store => {
	if (!isLegacyStore(passedStore)) {
		// It's not an old store, return as is
		return passedStore
	}

	// Why can't Typescript understand this?
	const legacyStore = passedStore

	class PromisifiedStore implements Store {
		async increment(key: string): Promise<IncrementResponse> {
			return new Promise((resolve, reject) => {
				legacyStore.incr(
					key,
					(
						error: Error | undefined,
						totalHits: number,
						resetTime: Date | undefined,
					) => {
						if (error) reject(error)
						resolve({ totalHits, resetTime })
					},
				)
			})
		}

		async decrement(key: string): Promise<void> {
			return Promise.resolve(legacyStore.decrement(key))
		}

		async resetKey(key: string): Promise<void> {
			return Promise.resolve(legacyStore.resetKey(key))
		}

		async resetAll(): Promise<void> {
			if (typeof legacyStore.resetAll === 'function')
				return Promise.resolve(legacyStore.resetAll())
		}
	}

	return new PromisifiedStore()
}

/**
 * Adds the defaults for options the user has not specified.
 *
 * @param options {Options} - The options the user specifies
 *
 * @returns {Options} - A complete configuration object
 */
const parseOptions = (passedOptions: Partial<Options>): Options => {
	// Now add the defaults for the other options
	const options: Options = {
		windowMs: 60 * 1000,
		store: new MemoryStore(passedOptions.windowMs ?? 60 * 1000),
		max: 5,
		message: 'Too many requests, please try again later.',
		statusCode: 429,
		legacyHeaders: true,
		standardHeaders: false,
		requestPropertyName: 'rateLimit',
		skipFailedRequests: false,
		skipSuccessfulRequests: false,
		requestWasSuccessful: (_request, response) => response.statusCode < 400,
		keyGenerator: (request) => {
			if (!request.ip) {
				console.error(
					'WARN | `express-rate-limit` | `request.ip` is undefined. You can avoid this by providing a custom `keyGenerator` function, but it may be indicative of a larger issue.',
				)
			}

			return request.ip
		},
		skip: () => false,
		handler: (_request, response, _optionsUsed: Options) =>
			response.status(options.statusCode).send(options.message),
		onLimitReached: () => {},
		...passedOptions,
	}

	// Ensure that the store passed implements the either the `Store` or `LegacyStore`
	// interface
	if (
		typeof options.store.increment !== 'function' ||
		typeof options.store.resetKey !== 'function' ||
		(options.skipFailedRequests &&
			typeof options.store.decrement !== 'function')
	) {
		throw new Error(
			'An invalid store was passed. Please ensure that the store is a class that implements the `Store` interface.',
		)
	} else {
		// Promisify the store, if it is not already
		options.store = promisifyStore(options.store)
	}

	// Throw an error if any deprecated options are passed
	const deprecatedOptions = [
		'global',
		'delayMs',
		'delayAfter',
		'headers',
		'draft_polli_ratelimit_headers',
	] as Array<keyof Options>
	for (const option of deprecatedOptions) {
		if (typeof passedOptions[option] !== 'undefined') {
			throw new TypeError(
				`The \`${option}\` option is deprecated/renamed and will likely be removed from the \`express-rate-limit\` package in the future.`,
			)
		}
	}

	// Return the 'clean' options
	return options
}

/**
 * Just pass on any errors for the developer to handle, usually as a HTTP 500
 * Internal Server Error.
 *
 * @param fn {Express.RequestHandler} - The request handler for which to handle errors
 *
 * @returns {Express.RequestHandler} - The request handler wrapped with a `.catch` clause
 *
 * @private
 */
const handleAsyncErrors =
	(fn: Express.RequestHandler): Express.RequestHandler =>
	async (
		request: Express.Request,
		response: Express.Response,
		next: Express.NextFunction,
	) => {
		try {
			await Promise.resolve(fn(request, response, next)).catch(next)
		} catch (error: unknown) {
			next(error)
		}
	}

/**
 *
 * Create an instance of IP rate-limiting middleware for Express.
 *
 * @param passedOptions {Options} - Options to configure the rate limiter
 *
 * @returns {RateLimitRequestHandler} - The middleware that rate-limits clients based on your configuration
 *
 * @public
 */
const rateLimit = (
	passedOptions?: Partial<Options>,
): RateLimitRequestHandler => {
	// Parse the options and add the default values for unspecified options
	const options = parseOptions(passedOptions ?? {})

	// Then return the actual middleware
	const middleware = handleAsyncErrors(
		async (
			request: Express.Request,
			response: Express.Response,
			next: Express.NextFunction,
		) => {
			// First check if we should skip the request
			const skip = await Promise.resolve(options.skip(request, response))
			if (skip) {
				next()
				return
			}

			// Create an augmented request
			const augmentedRequest = request as AugmentedRequest

			// Get a unique key for the client
			const key = await Promise.resolve(options.keyGenerator(request, response))
			// Increment the client's hit counter by one
			const { totalHits, resetTime } = await options.store.increment(key)

			// Get the quota (max number of hits) for each client
			const retrieveQuota =
				typeof options.max === 'function'
					? options.max(request, response)
					: options.max

			const maxHits = await Promise.resolve(retrieveQuota)
			// Set the rate limit information on the augmented request object
			augmentedRequest[options.requestPropertyName] = {
				limit: maxHits,
				current: totalHits,
				remaining: Math.max(maxHits - totalHits, 0),
				resetTime,
			}

			// Set the X-RateLimit headers on the response object if enabled
			if (options.legacyHeaders && !response.headersSent) {
				response.setHeader('X-RateLimit-Limit', maxHits)
				response.setHeader(
					'X-RateLimit-Remaining',
					augmentedRequest[options.requestPropertyName].remaining,
				)

				// If we have a resetTime, also provide the current date to help avoid issues with incorrect clocks
				if (resetTime instanceof Date) {
					response.setHeader('Date', new Date().toUTCString())
					response.setHeader(
						'X-RateLimit-Reset',
						Math.ceil(resetTime.getTime() / 1000),
					)
				}
			}

			// Set the standardized RateLimit headers on the response object
			// if enabled
			if (options.standardHeaders && !response.headersSent) {
				response.setHeader('RateLimit-Limit', maxHits)
				response.setHeader(
					'RateLimit-Remaining',
					augmentedRequest[options.requestPropertyName].remaining,
				)

				if (resetTime) {
					const deltaSeconds = Math.ceil(
						(resetTime.getTime() - Date.now()) / 1000,
					)
					response.setHeader('RateLimit-Reset', Math.max(0, deltaSeconds))
				}
			}

			// If we are to skip failed/successfull requests, decrement the
			// counter accordingly once we know the status code of the request
			if (options.skipFailedRequests || options.skipSuccessfulRequests) {
				let decremented = false
				const decrementKey = async () => {
					if (!decremented) {
						await options.store.decrement(key)
						decremented = true
					}
				}

				if (options.skipFailedRequests) {
					response.on('finish', async () => {
						if (!options.requestWasSuccessful(request, response))
							await decrementKey()
					})
					response.on('close', async () => {
						if (!response.writableEnded) await decrementKey()
					})
					response.on('error', async () => {
						await decrementKey()
					})
				}

				if (options.skipSuccessfulRequests) {
					response.on('finish', async () => {
						if (options.requestWasSuccessful(request, response))
							await decrementKey()
					})
				}
			}

			// Call the {@link Options.onLimitReached} callback if
			// the client has reached their rate limit.
			if (maxHits && totalHits === maxHits + 1) {
				options.onLimitReached(request, response, options)
			}

			// If the client has exceeded their rate limit, set the Retry-After
			// header and call the {@link Options.handler} function
			if (maxHits && totalHits > maxHits) {
				if (options.legacyHeaders && !response.headersSent) {
					response.setHeader('Retry-After', Math.ceil(options.windowMs / 1000))
				}

				options.handler(request, response, options)
				return
			}

			next()
		},
	)

	// Export the store's function to reset the hit counter for a particular
	// client based on their identifier
	;(middleware as RateLimitRequestHandler).resetKey =
		options.store.resetKey.bind(options.store)

	return middleware as RateLimitRequestHandler
}

// Export it to the world!
export default rateLimit
