var errors = require('./errors');
var Bluebird = require('bluebird');
var request = require('request');
var _ = require('lodash');
var querystring = require('querystring');

var VERSION = require('../package.json').version;

var STATUS_MAP = Object.keys(errors).reduce(function(map, key) {
  var error = new errors[key](null);
  if (error.status) {
    map[error.status] = errors[key];
  }
  return map;
}, {});

// TODO: Provide same set of options for each request as for configuration,
// so the config at construction time is just the "defaults"

/**
 * Creates a dispatcher which will act as a basic wrapper for making HTTP
 * requests to the API, and handle authentication.
 * @class
 * @classdesc A HTTP wrapper for the Asana API
 * @param {Object} options for default behavior of the Dispatcher
 * @option {Authenticator} [authenticator] Object to use for authentication.
 *     Can also be set later with `setAuthenticator`.
 * @option {String} [retryOnRateLimit] Automatically handle `RateLimitEnforced`
 *     errors by sleeping and retrying after the waiting period.
 * @option {Function} [handleUnauthorized] Automatically handle
 *     `NoAuthorization` with the callback. If the callback returns `true`
 *     (or a promise resolving to `true), will retry the request.
 * @option {String} [asanaBaseUrl] Base URL for Asana, for debugging
 * @option {Number} [requestTimeout] Timeout (in milliseconds) to wait for the
 *     request to finish.
 */
function Dispatcher(options) {
  options = options || {};
  /**
   * The object to use to handle authentication.
   * @type {Authenticator}
   */
  this.authenticator = options.authenticator || null;
  /**
   * The base URL for Asana
   * @type {String}
   */
  this.asanaBaseUrl = options.asanaBaseUrl || 'https://app.asana.com/';
  /**
   * Whether requests should be automatically retried if rate limited.
   * @type {Boolean}
   */
  this.retryOnRateLimit = options.retryOnRateLimit || false;
  /**
   * What headers should be included by default in all requests, if any.
   * Can be overridden by individual requests.
   * @type {Object}
   */
  this.defaultHeaders = options.defaultHeaders || {};
  /**
   * Handler for unauthorized requests which may seek reauthorization.
   * Default behavior is available if configured with an Oauth authenticator
   * that has a refresh token, and will refresh the current access token.
   * @type {Function}
   */
  this.handleUnauthorized = (options.handleUnauthorized !== undefined) ?
      options.handleUnauthorized : Dispatcher.maybeReauthorize;
  /**
   * Version info gathered from the system, to send with the request.
   * @type {Object}
   */
  this._cachedVersionInfo = null;

  /**
   * The amount of time in milliseconds to wait for a request to finish.
   * @type {Number}
   */
  this.requestTimeout = options.requestTimeout || null;

  /**
   * What proxy should be used by default in all requests, if any.
   * Can be overridden by individual requests.
   * @type {String}
   */
  this.defaultProxy = options.defaultProxy || null;
}

/**
 * The relative API path for the current version of the Asana API.
 * @type {String}
 */
Dispatcher.API_PATH = 'api/1.0';

/**
 * Default handler for requests that are considered unauthorized.
 * Requests that the authenticator try to refresh its credentials if
 * possible.
 * @return {Promise<boolean>} True iff refresh was successful, false if not.
 */
Dispatcher.maybeReauthorize = function() {
  if (!this.authenticator) {
    return false;
  }
  return this.authenticator.refreshCredentials();
};

/**
 * Creates an Asana API Url by concatenating the ROOT_URL with path provided.
 * @param  {String} path The path
 * @return {String}      The url
 */
Dispatcher.prototype.url = function(path) {
  return this.asanaBaseUrl + Dispatcher.API_PATH + path;
};

/**
 * Configure the authentication mechanism to use.
 * @returns {Dispatcher} this
 */
Dispatcher.prototype.setAuthenticator = function(authenticator) {
  this.authenticator = authenticator;
  return this;
};

/**
 * Ensure the dispatcher is authorized to make requests. Call this before
 * making any API requests.
 *
 * @returns {Promise} Resolves when the dispatcher is authorized, rejected if
 *     there was a problem authorizing.
 */
Dispatcher.prototype.authorize = function() {
  if (this.authenticator === null) {
    throw new Error('No authenticator configured for dispatcher');
  }
  return this.authenticator.establishCredentials();
};

/**
 * Dispatches a request to the Asana API. The request parameters are passed to
 * the request module.
 * @param  {Object}  params The params for request
 * @param  {Object}  [dispatchOptions] Options for handling request/response
 * @return {Promise}        The response for the request
 */
Dispatcher.prototype.dispatch = function(params, dispatchOptions) {
  var me = this;
  // TODO: actually honor these options as overriding defaults
  dispatchOptions = dispatchOptions || {};

  if (this.requestTimeout) {
    params.timeout = this.requestTimeout;
  }

  if (this.defaultProxy) {
    params.proxy = this.defaultProxy;
  }

  return new Bluebird(function(resolve, reject) {
    function doRequest() {
      if (me.authenticator !== null) {
        me.authenticator.authenticateRequest(params);
      }
      params.headers = _.extend(
          {}, params.headers, me.defaultHeaders, dispatchOptions.headers || {});
      me._addVersionInfo(params);
      request(params, function(err, res, payload) {
        if (err) {
          return reject(err);
        }
        if (STATUS_MAP[res.statusCode]) {
          var error = new STATUS_MAP[res.statusCode](payload);

          if (me.retryOnRateLimit &&
              error instanceof (errors.RateLimitEnforced)) {
            // Maybe attempt retry for rate limiting.
            // Delay a half-second more in case of rounding error.
            // TODO: verify Asana is always being conservative with duration
            setTimeout(doRequest, error.retryAfterSeconds * 1000 + 500);

          } else if (me.handleUnauthorized &&
              error instanceof (errors.NoAuthorization)) {
            // Maybe attempt to retry unauthorized requests after getting
            // a new access token.
            Bluebird.resolve(me.handleUnauthorized()).then(function(reauth) {
              if (reauth) {
                doRequest();
              } else {
                reject(error);
              }
            })
            .catch(function() {
                reject(error);
            });
          } else {
            // Not an error we can handle.
            return reject(error);
          }
        } else {
          return resolve(payload);
        }
      });
    }
    doRequest();
  });
};

/**
 * Dispatches a GET request to the Asana API.
 * @param  {String}  path    The path of the API
 * @param  {Object}  [query] The query params
 * @param  {Object}  [dispatchOptions] Options for handling the request and
 *     response. See `dispatch`.
 * @return {Promise}         The response for the request
 */
Dispatcher.prototype.get = function(path, query, dispatchOptions) {
  var params = {
    method: 'GET',
    url: this.url(path),
    json: true
  };
  if (query) {
    params.qs = query;
  }
  return this.dispatch(params, dispatchOptions);
};

/**
 * Dispatches a POST request to the Asana API.
 * @param  {String} path The path of the API
 * @param  {Object} data The data to be sent
 * @param  {Object}  [dispatchOptions] Options for handling the request and
 *     response. See `dispatch`.
 * @return {Promise}     The response for the request
 */
Dispatcher.prototype.post = function(path, data, dispatchOptions) {
  var params = {
    method: 'POST',
    url: this.url(path),
    json: {
      data: data
    }
  };
  return this.dispatch(params, dispatchOptions);
};

/**
 * Dispatches a PUT request to the Asana API.
 * @param  {String} path The path of the API
 * @param  {Object} data The data to be sent
 * @param  {Object}  [dispatchOptions] Options for handling the request and
 *     response. See `dispatch`.
 * @return {Promise}     The response for the request
 */
Dispatcher.prototype.put = function(path, data, dispatchOptions) {
  var params = {
    method: 'PUT',
    url: this.url(path),
    json: {
      data: data
    }
  };
  return this.dispatch(params, dispatchOptions);
};

/**
 * Dispatches a DELETE request to the Asana API.
 * @param  {String} path The path of the API
 * @param  {Object}  [dispatchOptions] Options for handling the request and
 *     response. See `dispatch`.
 * @return {Promise}     The response for the request
 */
Dispatcher.prototype.delete = function(path, dispatchOptions) {
  var params = {
    method: 'DELETE',
    url: this.url(path)
  };
  return this.dispatch(params, dispatchOptions);
};

/**
 * @param request {Object} Request to add version header to.
 * @private
 */
Dispatcher.prototype._addVersionInfo = function(request) {
  if (!this._cachedVersionInfo) {
    this._cachedVersionInfo = this._generateVersionInfo();
  }
  request.headers = request.headers || {};
  request.headers['X-Asana-Client-Lib'] =
      querystring.stringify(this._cachedVersionInfo);
};

/**
 * @return {Object} Dictionary of key-value pairs indicating library version
 * @private
 */
Dispatcher.prototype._generateVersionInfo = function() {
  if (typeof(navigator) === 'undefined' || typeof(window) === 'undefined') {
    var os = require('os');
    return {
      'version': VERSION,
      'language': 'NodeJS',
      'language_version': process.version,
      'os': os.type(),
      'os_version': os.release()
    };
  } else {
    return {
      'version': VERSION,
      'language': 'BrowserJS'
    };
  }
};

module.exports = Dispatcher;
