import fs from 'fs/promises'
import _ from 'lodash'
import yaml from 'yaml'
import { hashPassword } from './crypt'
import { setHidden, wantArray } from './misc'
import { watchLoad } from './watchLoad'
import Koa from 'koa'
import { CFG_ALLOW_CLEAR_TEXT_LOGIN, getConfig, subscribeConfig } from './config'
import { createVerifierAndSalt, SRPParameters, SRPRoutines } from 'tssrp6a'

let path = ''

interface Account {
    username: string, // we'll have username in it, so we don't need to pass it separately
    password?: string
    hashedPassword?: string
    srp?: string
    belongs?: string[]
}
interface Accounts { [username:string]: Account }

let accounts: Accounts = {}

export function getCurrentUsername(ctx: Koa.Context): string {
    return ctx.session?.username || ''
}

// provides the username and all other usernames it inherits based on the 'belongs' attribute. Useful to check permissions
export async function getCurrentUsernameExpanded(ctx: Koa.Context) {
    const who = getCurrentUsername(ctx)
    if (!who)
        return []
    const ret = [who]
    for (const u of ret) {
        const a = getAccount(u)
        if (a?.belongs)
            ret.push(...a.belongs)
    }
    return ret
}

export function getAccount(username:string) : Account | undefined {
    return username ? accounts[username] : undefined
}

export function saveSrpInfo(account:Account, salt:string | bigint, verifier: string | bigint) {
    account.srp = String(salt) + '|' + String(verifier)
}

const srp6aNimbusRoutines = new SRPRoutines(new SRPParameters())

type Changer = (account:Account)=> void | Promise<void>
export async function updateAccount(account: Account, changer?:Changer) {
    const was = JSON.stringify(account)
    await changer?.(account)
    const { username } = account
    if (account.password) {
        console.debug('hashing password for', username)
        if (getConfig(CFG_ALLOW_CLEAR_TEXT_LOGIN))
            account.hashedPassword = await hashPassword(account.password)
        const res = await createVerifierAndSalt(srp6aNimbusRoutines, username, account.password)
        saveSrpInfo(account, res.s, res.v)
        delete account.password
    }
    else if (!account.srp && account.hashedPassword) {
        console.log('please reset password for account', username)
        process.exit(1)
    }
    account.belongs = wantArray(account.belongs).filter(b =>
        b in accounts // at this stage the group record may still be null if specified later in the file
        || console.error(`account ${username} belongs to non-existing ${b}`) )
    if (was !== JSON.stringify(account))
        saveAccountsAsap()
}

let saving = false
const saveAccountsAsap = _.debounce(() => {
    saving = true
    fs.writeFile(path, yaml.stringify({ accounts }, { lineWidth:1000 })) // we don't want big numbers to be folded
        .catch(err => console.error('Failed at saving accounts file, please ensure it is writable.', String(err)))
        .finally(()=> saving = false)
})

let watcher: undefined | (()=>void)
subscribeConfig({ k:'accounts', defaultValue:'accounts.yaml' }, v => {
    watcher?.()
    if (!v)
        return applyAccounts({})
    if (typeof v !== 'string')
        return console.error('bad type for accounts')
    watcher = watchLoad(path = v, async data => {
        if (saving) return
        const a = data?.accounts
        if (!a)
            return console.error('accounts file must contain "accounts" key')
        await applyAccounts(a)
    })
})

async function applyAccounts(newAccounts:Accounts) {
    // we should validate content here
    accounts = newAccounts
    await Promise.all(_.map(accounts, async (rec,k) => {
        const lc = k.toLocaleLowerCase()
        if (!rec) // an empty object in yaml is stored as null
            rec = accounts[lc] = { username: lc, srp:'' }
        else if (lc !== k) {
            accounts[lc] = rec
            delete accounts[k]
            k = lc
        }
        setHidden(rec, { username: k })
        await updateAccount(rec)
    }))
}
