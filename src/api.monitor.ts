// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import _ from 'lodash'
import { Connection, getConnections } from './connections'
import { pendingPromise, shortenAgent, typedEntries, wait } from './misc'
import { ApiHandlers, SendListReadable } from './apiMiddleware'
import Koa from 'koa'
import { totalGot, totalInSpeed, totalOutSpeed, totalSent } from './throttler'
import { getCurrentUsername } from './auth'

const apis: ApiHandlers = {

    async disconnect({ ip, port, wait }) {
        const match = _.matches({ ip, port })
        const c = getConnections().find(c => match(getConnAddress(c)))
        if (c) {
            const waiter = pendingPromise<void>()
            c.socket.end(waiter.resolve)
            c.ctx?.res.end()
            c.ctx?.req.socket.end('')
            if (wait)
                await waiter
        }
        return { result: Boolean(c) }
    },

    get_connections({}, ctx) {
        const sent = Symbol('sent')
        const list = new SendListReadable({
            addAtStart: getConnections().map(c =>
                !ignore(c) && (c[sent] = serializeConnection(c))).filter(Boolean),
            onEnd() {
                for (const c of getConnections())
                    delete c[sent]
            }
        })
        type Change = Partial<Omit<Connection,'ip'>>
        list.props({ you: ctx.ip })
        return list.events(ctx, {
            connection(conn: Connection) {
                if (ignore(conn)) return
                list.add(conn[sent] = serializeConnection(conn))
            },
            connectionClosed(conn: Connection) {
                if (ignore(conn)) return
                list.remove(getConnAddress(conn))
                delete conn[sent]
            },
            connectionUpdated(conn: Connection, change: Change) {
                if (ignore(conn) || ignore(change as any) || !conn[sent]) return
                if (change.ctx) {
                    Object.assign(change, fromCtx(change.ctx))
                    change.ctx = undefined
                }
                if (change.opProgress)
                    change.opProgress = _.round(change.opProgress, 3)
                // avoid sending non-changes
                const last = conn[sent]
                for (const [k, v] of typedEntries(change))
                    if (v === last[k])
                        delete change[k]
                if (_.isEmpty(change)) return
                Object.assign(last, change)
                list.update(getConnAddress(conn), change)
            },
        })

        function serializeConnection(conn: Connection) {
            const { socket, started, secure } = conn
            return {
                ...getConnAddress(conn),
                v: (socket.remoteFamily?.endsWith('6') ? 6 : 4),
                got: socket.bytesRead,
                sent: socket.bytesWritten,
                ..._.pick(conn, ['op', 'opTotal', 'opOffset', 'opProgress', 'country']),
                started,
                secure: (secure || undefined) as boolean|undefined, // undefined will save some space once json-ed
                ...fromCtx(conn.ctx),
            }
        }

        function fromCtx(ctx?: Koa.Context) {
            if (!ctx) return
            const s = ctx.state // short alias
            return {
                user: getCurrentUsername(ctx),
                agent: shortenAgent(ctx.get('user-agent')),
                archive: s.archive,
                upload: s.uploadProgress,
                ...s.browsing ? { op: 'browsing', path: decodeURIComponent(s.browsing) }
                    : s.uploadPath ? { op: 'upload',path: decodeURIComponent(s.uploadPath) }
                    : { path: decodeURIComponent(ctx.path) }
            }
        }
    },

    async *get_connection_stats() {
        while (1) {
            yield {
                outSpeed: totalOutSpeed,
                inSpeed: totalInSpeed,
                got: totalGot,
                sent: totalSent,
                connections: _.sumBy(getConnections(), x => ignore(x) ? 0 : 1),
            }
            await wait(1000)
        }
    },
}

export default apis

function ignore(conn: Connection) {
    return false //conn.socket && isLocalHost(conn)
}

function getConnAddress(conn: Connection) {
    return {
        ip: conn.ip,
        port: conn.socket.remotePort,
    }
}
