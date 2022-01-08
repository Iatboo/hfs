import proxy from 'koa-better-http-proxy'
import Koa from 'koa'
import { readFile } from 'fs'
import { DEV, FRONTEND_URI, METHOD_NOT_ALLOWED, NO_CONTENT } from './const'
import { serveFile } from './serveFile'

export const serveFrontend = DEV ? serveProxyFrontend() : serveStaticFrontend()

function serveProxyFrontend() {
    console.debug('fronted: proxied')
    return proxy('localhost:3000', {
        filter: ctx => ctx.method === 'GET' || (ctx.status = METHOD_NOT_ALLOWED) && false,
        proxyReqPathResolver: (ctx) => ctx.path.endsWith('/') ? '/' : ctx.path,
        userResDecorator: (res, data, req) => {
            return req.url.endsWith('/') ? replaceFrontEndRes(data.toString('utf8'))
                : data
        }
    })
}

function serveStaticFrontend() : Koa.Middleware {
    const BASE = __dirname + (DEV ? '/../dist' : '') + '/frontend/'
    return async (ctx, next) => {
        let { path, method } = ctx
        if (method === 'OPTIONS') {
            ctx.status = NO_CONTENT
            ctx.set({ Allow: 'OPTIONS, GET' })
            return
        }
        if (method !== 'GET')
            return ctx.status = METHOD_NOT_ALLOWED
        if (path.endsWith('/')) {
            ctx.body = replaceFrontEndRes(String(await filePromise(BASE + 'index.html')))
            ctx.type = 'html'
        } else {
            const fullPath = BASE + path.slice(1)
            if (path.includes('static/js')) {// webpack
                ctx.body = String(await filePromise(fullPath))
                    .replace(/(return")(static\/)/g, '$1' + FRONTEND_URI.substring(1) + '$2')
                ctx.type = 'js'
            }
            else
                return serveFile(fullPath, 'auto')(ctx, next)
        }
        await next()
    }
}

function filePromise(path: string) : Promise<Buffer> {
    return new Promise((resolve, reject) =>
        readFile(path, (err,res) =>
            err ? reject(err) : resolve(res) ))
}

function replaceFrontEndRes(body: string) {
    return body.replace(/((?:src|href) *= *['"])\/?(?![a-z]+:\/\/)/g, '$1'+FRONTEND_URI)
}
