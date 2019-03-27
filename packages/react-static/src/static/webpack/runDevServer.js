/* eslint-disable import/no-dynamic-require, react/no-danger, import/no-mutable-exports */
import webpack from 'webpack'
import chalk from 'chalk'
import io from 'socket.io'
import WebpackDevServer from 'webpack-dev-server'
//
import getWebpackConfig from './getWebpackConfig'
import getRouteData from '../getRouteData'
import { findAvailablePort, time, timeEnd } from '../../utils'

let devServer
let latestState
let buildDevRoutes = () => {}
let reloadClientData = () => {}

export { reloadClientData }

// Starts the development server
export default async function runDevServer(state) {
  // TODO check config.devServer for changes and notify user
  // if the server needs to be restarted for changes to take
  // effect.

  // If the server is already running, trigger a refresh to the client

  if (devServer) {
    await buildDevRoutes(state)
    await reloadClientData()
  } else {
    state = await runExpressServer(state)
  }

  return state
}

async function runExpressServer(state) {
  // Default to localhost:3000, or use a custom combo if defined in static.config.js
  // or environment variables
  const intendedPort = Number(state.config.devServer.port)
  const port = await findAvailablePort(intendedPort)

  // Find an available port for messages, as long as it's not the devServer port
  const messagePort = await findAvailablePort(4000, [port])

  if (intendedPort !== port) {
    console.log(
      chalk.red(
        `=> Warning! Port ${intendedPort} is not available. Using port ${chalk.green(
          intendedPort
        )} instead!`
      )
    )
  }

  state = {
    ...state,
    config: {
      ...state.config,
      devServer: {
        ...state.config.devServer,
        port,
      },
    },
  }

  const devConfig = getWebpackConfig(state)
  const devCompiler = webpack(devConfig)

  const devServerConfig = {
    hot: true,
    contentBase: [state.config.paths.PUBLIC, state.config.paths.DIST],
    publicPath: '/',
    historyApiFallback: true,
    compress: false,
    clientLogLevel: 'warning',
    overlay: true,
    stats: 'errors-only',
    noInfo: true,
    ...state.config.devServer,
    watchOptions: {
      ...(state.config.devServer
        ? state.config.devServer.watchOptions || {}
        : {}),
      ignored: [
        /node_modules/,

        ...((state.config.devServer.watchOptions || {}).ignored || []),
      ],
    },
    before: app => {
      // Serve the site data
      app.get('/__react-static__/getMessagePort', async (req, res) => {
        res.send({
          port: messagePort,
        })
      })
      // Since routes may change during dev, this function can rebuild all of the config
      // routes. It also references the original config when possible, to make sure it
      // uses any up to date getData callback generated from new or replacement routes.
      buildDevRoutes = async newState => {
        latestState = newState

        app.get('/__react-static__/siteData', async (req, res, next) => {
          try {
            res.send(latestState.siteData)
          } catch (err) {
            res.status(500)
            res.send(err)
            next(err)
          }
        })

        // Serve each routes data
        latestState.routes.forEach(({ path: routePath }) => {
          app.get(
            `/__react-static__/routeInfo/${encodeURI(
              routePath === '/' ? '' : routePath
            )}`,
            async (req, res, next) => {
              // Make sure we have the most up to date route from the config, not
              // an out of dat object.
              let route = latestState.routes.find(d => d.path === routePath)
              try {
                if (!route) {
                  throw new Error('Route could not be found!')
                }

                route = await getRouteData(route, latestState)

                // Don't use any hashProp, just pass all the data in dev
                res.json(route)
              } catch (err) {
                res.status(404)
                next(err)
              }
            }
          )
        })
        return new Promise(resolve => setTimeout(resolve, 1))
      }

      buildDevRoutes(state)

      if (state.config.devServer && state.config.devServer.before) {
        state.config.devServer.before(app)
      }

      return app
    },
  }

  let first = true
  const startedAt = Date.now()
  let skipLog = false

  console.log('=> Bundling Application...')
  time(chalk.green('=> [\u2713] Application Bundled'))

  devCompiler.hooks.invalid.tap(
    {
      name: 'React-Static',
    },
    (file, changed) => {
      // If a file is changed within the first two seconds of
      // the server starting, we don't bark about it. Less
      // noise is better!
      skipLog = changed - startedAt < 2000
      if (!skipLog) {
        console.log(
          '=> File changed:',
          file.replace(state.config.paths.ROOT, '')
        )
        console.log('=> Updating bundle...')
        time(chalk.green('=> [\u2713] Bundle Updated'))
      }
    }
  )

  devCompiler.hooks.done.tap(
    {
      name: 'React-Static',
    },
    stats => {
      const messages = stats.toJson({}, true)
      const isSuccessful = !messages.errors.length && !messages.warnings.length

      if (isSuccessful && !skipLog) {
        if (first) {
          timeEnd(chalk.green('=> [\u2713] Application Bundled'))
          console.log(
            chalk.green('=> [\u2713] App serving at'),
            `${state.config.devServer.host}:${state.config.devServer.port}`
          )
        } else {
          timeEnd(chalk.green('=> [\u2713] Bundle Updated'))
        }
      }

      first = false
    }
  )

  // Start the webpack dev server
  devServer = new WebpackDevServer(devCompiler, devServerConfig)

  // Start the messages socket
  const socket = io()

  reloadClientData = () => {
    socket.emit('message', { type: 'reloadClientData' })
  }

  await new Promise((resolve, reject) => {
    devServer.listen(port, null, err => {
      if (err) {
        return reject(err)
      }
      resolve()
    })
  })

  // Make sure we start listening on the message port after the dev server.
  // We do this mostly to appease codesandbox.io, since they autobind to the first
  // port that opens up for their preview window.
  socket.listen(messagePort)

  return state
}