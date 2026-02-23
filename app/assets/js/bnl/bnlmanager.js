const AdmZip = require('adm-zip')
const child_process = require('child_process')
const crypto = require('crypto')
const fs = require('fs-extra')
const got = require('got')
const path = require('path')
const { LoggerUtil } = require('helios-core')

const ConfigManager = require('../configmanager')
const win64Manifest = require('./bnlmanifest.json')

const logger = LoggerUtil.getLogger('BlockNLoad')

const BNL_APP_ID = '299360'
const BNL_EXE_RELATIVE_PATH = path.join('Win64', 'BlockNLoad.exe')
const BNL_SERVER_HOST = '5.175.220.106'
const BNL_SERVER_PORT = 28100
const ORIGINAL_SERVER_IP = '162.55.251.122'
const STEAMCMD_ZIP_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
const GOLDBERG_SITE_URL = 'https://mr_goldberg.gitlab.io/goldberg_emulator/'

function getInstallRoot(){
    if(ConfigManager.getBnlInstallRoot != null){
        return ConfigManager.getBnlInstallRoot()
    }
    return path.join(ConfigManager.getDataDirectory(), 'games', 'blocknload')
}

function getSteamCmdDir(){
    return path.join(ConfigManager.getDataDirectory(), 'tools', 'steamcmd')
}

function getSteamCmdSeedDir(){
    return path.join(__dirname, '..', '..', 'steamcmd-seed')
}

function getSteamCmdExe(){
    return path.join(getSteamCmdDir(), 'steamcmd.exe')
}

function getGoldbergDir(){
    return path.join(ConfigManager.getDataDirectory(), 'tools', 'goldberg')
}

function getGoldbergZipPath(){
    return path.join(getGoldbergDir(), 'goldberg.zip')
}

function getGoldbergDllPath(){
    return path.join(getGoldbergDir(), 'steam_api64.dll')
}

function getSteamCmdConfigPath(rootDir = getSteamCmdDir()){
    return path.join(rootDir, 'config', 'config.vdf')
}

function getSteamCmdConsoleLogPath(){
    return path.join(getSteamCmdDir(), 'logs', 'console_log.txt')
}

function reportStatus(options, key, fallback){
    if(options?.onStatus){
        options.onStatus(options?.messages?.[key] ?? fallback)
    }
}

function reportProgress(options, percent){
    if(options?.onProgress){
        options.onProgress(percent)
    }
}

async function sha1File(filePath){
    if(!await fs.pathExists(filePath)){
        return null
    }
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1')
        const stream = fs.createReadStream(filePath)
        stream.on('data', data => hash.update(data))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
    })
}

async function parseSteamCmdAccounts(configPath){
    if(!await fs.pathExists(configPath)){
        return []
    }
    const raw = await fs.readFile(configPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    let inAccounts = false
    let depth = 0
    const accounts = []

    for(const rawLine of lines){
        const line = rawLine.trim()
        if(!inAccounts){
            if(line.startsWith('"Accounts"')){
                inAccounts = true
                const openCount = (line.match(/{/g) || []).length
                const closeCount = (line.match(/}/g) || []).length
                depth += openCount - closeCount
                if(depth <= 0){
                    depth = 0
                }
                continue
            }
        } else {
            if(depth === 1){
                const match = line.match(/^"([^"]+)"/)
                if(match != null){
                    accounts.push(match[1])
                }
            }

            const openCount = (line.match(/{/g) || []).length
            const closeCount = (line.match(/}/g) || []).length
            depth += openCount - closeCount
            if(depth <= 0){
                inAccounts = false
            }
        }
    }

    return accounts
}

function createLogTailer(filePath, onLine){
    let position = 0
    let buffer = ''
    let busy = false

    try {
        if(fs.existsSync(filePath)){
            position = fs.statSync(filePath).size
        }
    } catch (err) {
        position = 0
    }

    const poll = async () => {
        if(busy){
            return
        }
        busy = true
        try {
            if(!await fs.pathExists(filePath)){
                return
            }
            const stats = await fs.stat(filePath)
            if(stats.size < position){
                position = 0
            }
            if(stats.size > position){
                const length = stats.size - position
                const fd = await fs.open(filePath, 'r')
                const buf = Buffer.alloc(length)
                await fs.read(fd, buf, 0, length, position)
                await fs.close(fd)
                position = stats.size
                const text = buffer + buf.toString('utf8')
                const lines = text.split(/\r?\n/)
                buffer = lines.pop() || ''
                lines.forEach(line => onLine(line))
            }
        } catch (err) {
            logger.warn('SteamCMD log tailer error.', err)
        } finally {
            busy = false
        }
    }

    const interval = setInterval(poll, 500)
    return {
        stop: () => clearInterval(interval)
    }
}

async function getCachedSteamCmdAccountName(){
    const accounts = await parseSteamCmdAccounts(getSteamCmdConfigPath())
    if(accounts.length === 0){
        return null
    }
    return accounts[0]
}

async function injectSteamCmdSeedIfNeeded(){
    const seedRoot = getSteamCmdSeedDir()
    if(!await fs.pathExists(seedRoot)){
        return false
    }

    const seedConfigPath = path.join(seedRoot, 'config', 'config.vdf')
    const seedUserdataPath = path.join(seedRoot, 'userdata')
    if(!await fs.pathExists(seedConfigPath) || !await fs.pathExists(seedUserdataPath)){
        return false
    }

    const targetRoot = getSteamCmdDir()
    const existingAccounts = await parseSteamCmdAccounts(getSteamCmdConfigPath(targetRoot))
    if(existingAccounts.length > 0){
        return false
    }

    await fs.ensureDir(path.join(targetRoot, 'config'))
    await fs.copy(seedConfigPath, path.join(targetRoot, 'config', 'config.vdf'), { overwrite: true })
    await fs.copy(seedUserdataPath, path.join(targetRoot, 'userdata'), { overwrite: true })

    const entries = await fs.readdir(seedRoot)
    for(const entry of entries){
        if(entry.startsWith('ssfn')){
            await fs.copy(path.join(seedRoot, entry), path.join(targetRoot, entry), { overwrite: true })
        }
    }

    return true
}

async function downloadToFile(url, dest, options){
    await fs.ensureDir(path.dirname(dest))
    const tempPath = `${dest}.partial`
    try {
        await new Promise((resolve, reject) => {
            const downloadStream = got.stream(url, { timeout: { request: 60000 } })
            const fileWriterStream = fs.createWriteStream(tempPath)

            downloadStream.on('downloadProgress', progress => {
                if(progress.percent != null){
                    reportProgress(options, progress.percent * 100)
                }
            })

            downloadStream.on('error', reject)
            fileWriterStream.on('error', reject)
            fileWriterStream.on('finish', resolve)

            downloadStream.pipe(fileWriterStream)
        })
        await fs.move(tempPath, dest, { overwrite: true })
        reportProgress(options, 100)
    } catch (err) {
        await fs.remove(tempPath)
        throw err
    }
}

async function ensureSteamCmd(options){
    const steamCmdExe = getSteamCmdExe()
    if(await fs.pathExists(steamCmdExe)){
        return
    }

    reportStatus(options, 'preparing', 'Preparing Block N Load..')
    const steamCmdDir = getSteamCmdDir()
    const zipPath = path.join(steamCmdDir, 'steamcmd.zip')
    await downloadToFile(STEAMCMD_ZIP_URL, zipPath, options)

    const zip = new AdmZip(zipPath)
    zip.extractAllTo(steamCmdDir, true)
    await fs.remove(zipPath)

    if(!await fs.pathExists(steamCmdExe)){
        throw new Error('SteamCMD installation failed.')
    }
}

async function runSteamCmd(installRoot, options){
    const steamCmdExe = getSteamCmdExe()
    await fs.ensureDir(installRoot)
    await injectSteamCmdSeedIfNeeded()

    const accountName = await getCachedSteamCmdAccountName()
    const loginArgs = accountName != null ? ['+login', accountName] : ['+login', 'anonymous']

    reportProgress(options, 0)

    await new Promise((resolve, reject) => {
        const args = [
            '+@ShutdownOnFailedCommand', '1',
            '+@NoPromptForPassword', '1',
            '+force_install_dir', installRoot,
            ...loginArgs,
            '+app_info_update', '1',
            '+app_update', BNL_APP_ID, 'validate',
            '+quit'
        ]

        const proc = child_process.spawn(steamCmdExe, args, {
            cwd: getSteamCmdDir(),
            windowsHide: true
        })

        let missingConfig = false
        let forceInstallWarning = false
        let noSubscription = false
        let appDownloadActive = false
        let lastUpdateState = null

        const handleLine = (line) => {
            const normalized = line.trim()
            if(normalized.length === 0){
                return
            }
            const appIdTag = `AppID ${BNL_APP_ID}`
            if(normalized.includes('Missing configuration')){
                missingConfig = true
            }
            if(normalized.includes('Please use force_install_dir before logon!')){
                forceInstallWarning = true
            }
            if(normalized.includes('No subscription')){
                noSubscription = true
            }

            if(normalized.includes(appIdTag) && normalized.includes('App update changed') && normalized.includes('Downloading')){
                if(!appDownloadActive){
                    appDownloadActive = true
                    reportProgress(options, 0)
                }
            }

            const updateStartMatch = normalized.match(new RegExp(`AppID\\s+${BNL_APP_ID}\\s+update started\\s*:\\s*download\\s+(\\d+)\\/(\\d+)`, 'i'))
            if(updateStartMatch){
                appDownloadActive = true
                const downloaded = Number.parseInt(updateStartMatch[1], 10)
                const total = Number.parseInt(updateStartMatch[2], 10)
                if(total > 0){
                    reportProgress(options, (downloaded / total) * 100)
                }
            }

            const updateStateMatch = normalized.match(/Update state.*?\)\s+([^,]+),\s*progress:\s*([0-9.]+)(?:\s*\((\d+)\s*\/\s*(\d+)\))?/i)
            if(updateStateMatch){
                const stateLabel = updateStateMatch[1].trim().toLowerCase()
                let statusKey = null
                if(stateLabel.includes('verifying')){
                    statusKey = 'verifying'
                } else if(stateLabel.includes('committing')){
                    statusKey = 'committing'
                } else if(stateLabel.includes('downloading')){
                    statusKey = 'downloading'
                }

                if(statusKey != null && statusKey !== lastUpdateState){
                    lastUpdateState = statusKey
                    reportStatus(options, statusKey, `Block N Load update: ${stateLabel}`)
                }

                if(!appDownloadActive){
                    appDownloadActive = true
                }
                const progressVal = Number.parseFloat(updateStateMatch[2])
                const downloaded = updateStateMatch[3] != null ? Number.parseInt(updateStateMatch[3], 10) : null
                const total = updateStateMatch[4] != null ? Number.parseInt(updateStateMatch[4], 10) : null
                if(total != null && total > 0 && downloaded != null){
                    reportProgress(options, (downloaded / total) * 100)
                } else if(!Number.isNaN(progressVal)){
                    reportProgress(options, progressVal)
                }
            }

            const percentMatch = normalized.match(/(\d{1,3})%/)
            if(percentMatch && !appDownloadActive){
                reportProgress(options, Number.parseInt(percentMatch[1], 10))
            }
            logger.info(normalized)
        }

        const handleOutput = (data) => {
            const lines = data.toString().split('\n')
            lines.forEach(line => handleLine(line))
        }

        const logTailer = createLogTailer(getSteamCmdConsoleLogPath(), handleLine)

        proc.stdout.on('data', handleOutput)
        proc.stderr.on('data', handleOutput)
        proc.on('error', reject)
        proc.on('close', code => {
            logTailer.stop()
            if(code === 0){
                resolve()
                return
            }

            const err = new Error(`SteamCMD exited with code ${code}`)
            if(missingConfig){
                err.displayable = 'SteamCMD cannot access the Block N Load app configuration. Anonymous login may not be allowed for this app.'
            } else if(forceInstallWarning){
                err.displayable = 'SteamCMD reported force_install_dir should be set before login.'
            } else if(noSubscription){
                err.displayable = 'SteamCMD reported no subscription for Block N Load. The cached Steam account must own the game.'
            }
            reject(err)
        })
    })
}

function normalizeHex(hexStr){
    return hexStr.replace(/\s+/g, '')
}

function hexToBuffer(hexStr){
    return Buffer.from(normalizeHex(hexStr), 'hex')
}

function applyBinaryPatch(buffer, offset, beforeBytes, afterBytes){
    const current = buffer.slice(offset, offset + beforeBytes.length)
    if(!current.equals(beforeBytes)){
        throw new Error('Patch mismatch at offset.')
    }

    if(beforeBytes.length === afterBytes.length){
        afterBytes.copy(buffer, offset)
        return buffer
    }

    const diff = afterBytes.length - beforeBytes.length
    const newBuffer = Buffer.alloc(buffer.length + diff)
    buffer.copy(newBuffer, 0, 0, offset)
    afterBytes.copy(newBuffer, offset)
    buffer.copy(newBuffer, offset + afterBytes.length, offset + beforeBytes.length)
    return newBuffer
}

async function patchAssemblyCSharp(installRoot){
    const fullPath = path.join(installRoot, 'Win64', 'BlockNLoad_Data', 'Managed', 'Assembly-CSharp.dll')
    const hashBefore = 'CF008C2DCA408B77FF42DB770AA1B5782AAD360C'
    const hashAfter = '7F7DFA1A86B5AA8E5A05E7958E855B286C623877'

    if(!await fs.pathExists(fullPath)){
        throw new Error(`Missing file: ${fullPath}`)
    }

    const currentHash = await sha1File(fullPath)
    if(currentHash === hashAfter){
        return
    }

    if(currentHash !== hashBefore){
        const err = new Error(`Hash mismatch for ${fullPath}`)
        err.displayable = 'Block N Load files do not match expected version.'
        throw err
    }

    const serverIpAfter = (() => {
        if(BNL_SERVER_HOST.length > ORIGINAL_SERVER_IP.length){
            throw new Error(`Server IP '${BNL_SERVER_HOST}' exceeds ${ORIGINAL_SERVER_IP.length}-char slot`)
        }
        const buf = Buffer.alloc(Buffer.from(ORIGINAL_SERVER_IP, 'utf16le').length)
        Buffer.from(BNL_SERVER_HOST, 'utf16le').copy(buf)
        return buf
    })()

    const patches = [
        {
            offset: 0x00061F49,
            before: hexToBuffer('28 E8 0E 00 0A'),
            after:  hexToBuffer('00 00 00 00 17')
        },
        {
            offset: 0x003F147C,
            before: Buffer.from(ORIGINAL_SERVER_IP, 'utf16le'),
            after:  serverIpAfter
        },
        {
            offset: 0x0015B585,
            before: hexToBuffer('1C'),
            after:  hexToBuffer('16')
        }
    ].sort((a, b) => b.offset - a.offset)

    let buffer = await fs.readFile(fullPath)
    for(const patch of patches){
        buffer = applyBinaryPatch(buffer, patch.offset, patch.before, patch.after)
    }
    await fs.writeFile(fullPath, buffer)

    const updatedHash = await sha1File(fullPath)
    if(updatedHash !== hashAfter){
        throw new Error(`Failed to apply patch to ${fullPath}`)
    }
}

async function patchCSteamworks(installRoot){
    const fullPath = path.join(installRoot, 'Win64', 'BlockNLoad_Data', 'Plugins', 'CSteamworks.dll')
    const hashBefore = '8868E8ED1B9DA70226C3B0808345E8D7F931F996'
    const hashAfter = '9FB7D982911FDEF890B05A4A2C62A2EEC77B1719'

    if(!await fs.pathExists(fullPath)){
        throw new Error(`Missing file: ${fullPath}`)
    }

    const currentHash = await sha1File(fullPath)
    if(currentHash === hashAfter){
        return
    }

    if(currentHash !== hashBefore){
        const err = new Error(`Hash mismatch for ${fullPath}`)
        err.displayable = 'Block N Load files do not match expected version.'
        throw err
    }

    let buffer = await fs.readFile(fullPath)
    buffer = applyBinaryPatch(
        buffer,
        Number.parseInt('0000215F', 16),
        hexToBuffer('74'),
        hexToBuffer('EB')
    )
    await fs.writeFile(fullPath, buffer)

    const updatedHash = await sha1File(fullPath)
    if(updatedHash !== hashAfter){
        throw new Error(`Failed to apply patch to ${fullPath}`)
    }
}

async function applyPatches(installRoot, options){
    reportStatus(options, 'patching', 'Applying Block N Load patches..')
    reportProgress(options, 0)
    await patchAssemblyCSharp(installRoot)
    reportProgress(options, 50)
    await patchCSteamworks(installRoot)
    reportProgress(options, 100)
}

async function validateWin64Manifest(installRoot){
    const win64Root = path.join(installRoot, 'Win64')
    if(!await fs.pathExists(win64Root)){
        return false
    }

    for(const [relPath, expectedHash] of Object.entries(win64Manifest)){
        const fullPath = path.join(win64Root, ...relPath.split('/'))
        if(!await fs.pathExists(fullPath)){
            return false
        }
        const currentHash = await sha1File(fullPath)
        if(currentHash !== expectedHash){
            return false
        }
    }

    return true
}

function findFileRecursive(baseDir, targetName, maxDepth = 4){
    if(!fs.existsSync(baseDir)){
        return null
    }
    const stack = [{ dir: baseDir, depth: 0 }]
    while(stack.length > 0){
        const current = stack.pop()
        if(current.depth > maxDepth){
            continue
        }
        const entries = fs.readdirSync(current.dir, { withFileTypes: true })
        for(const entry of entries){
            const fullPath = path.join(current.dir, entry.name)
            if(entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()){
                return fullPath
            }
            if(entry.isDirectory()){
                stack.push({ dir: fullPath, depth: current.depth + 1 })
            }
        }
    }
    return null
}

async function findSteamApiDll(installRoot){
    const direct = path.join(installRoot, 'Win64', 'steam_api64.dll')
    if(await fs.pathExists(direct)){
        return direct
    }
    return findFileRecursive(installRoot, 'steam_api64.dll')
}

async function resolveGoldbergDownloadUrl(){
    const res = await got(GOLDBERG_SITE_URL)
    const body = res.body
    const match = body.match(/https?:\/\/gitlab\.com\/Mr_Goldberg\/goldberg_emulator\/\-\/jobs\/\d+\/artifacts\/download/i)
    if(match){
        return match[0]
    }
    const relMatch = body.match(/\/Mr_Goldberg\/goldberg_emulator\/\-\/jobs\/\d+\/artifacts\/download/i)
    if(relMatch){
        return `https://gitlab.com${relMatch[0]}`
    }
    throw new Error('Unable to locate Goldberg download url.')
}

function pickGoldbergEntry(entries){
    const candidates = entries.filter(entry => !entry.isDirectory && /steam_api64\.dll$/i.test(entry.entryName))
    if(candidates.length === 0){
        return null
    }
    const filtered = candidates.filter(entry => !/experimental|debug/i.test(entry.entryName))
    const pickFrom = filtered.length > 0 ? filtered : candidates
    pickFrom.sort((a, b) => a.entryName.length - b.entryName.length)
    return pickFrom[0]
}

async function ensureGoldbergCached(options){
    const cachedDll = getGoldbergDllPath()
    if(await fs.pathExists(cachedDll)){
        return cachedDll
    }

    await fs.ensureDir(getGoldbergDir())
    const downloadUrl = await resolveGoldbergDownloadUrl()
    await downloadToFile(downloadUrl, getGoldbergZipPath(), options)

    const zip = new AdmZip(getGoldbergZipPath())
    const entry = pickGoldbergEntry(zip.getEntries())
    if(entry == null){
        throw new Error('Goldberg emulator dll not found in archive.')
    }
    await fs.writeFile(cachedDll, entry.getData())
    await fs.remove(getGoldbergZipPath())
    return cachedDll
}

async function ensureGoldbergInstall(installRoot, nickname, options){
    reportStatus(options, 'goldberg', 'Configuring Goldberg Steam Emulator..')
    const cachedDll = await ensureGoldbergCached(options)
    const steamApiPath = await findSteamApiDll(installRoot)
    if(steamApiPath == null){
        throw new Error('steam_api64.dll not found in Block N Load install.')
    }
    await fs.copyFile(cachedDll, steamApiPath)

    const steamSettingsDir = path.join(path.dirname(steamApiPath), 'steam_settings')
    await fs.ensureDir(steamSettingsDir)
    await fs.writeFile(path.join(steamSettingsDir, 'force_account_name.txt'), `${nickname}`.trim(), 'utf8')
    await fs.writeFile(path.join(steamSettingsDir, 'steam_appid.txt'), BNL_APP_ID, 'utf8')

    const appIdPath = path.join(installRoot, 'steam_appid.txt')
    await fs.writeFile(appIdPath, BNL_APP_ID, 'utf8')

    const goldbergHash = await sha1File(steamApiPath)
    return {
        goldbergHash,
        steamApiPath
    }
}

async function repairInstall(installRoot, options){
    reportStatus(options, 'downloading', 'Downloading Block N Load..')
    await ensureSteamCmd(options)
    await runSteamCmd(installRoot, options)
}

async function runRepairPipeline(installRoot, options){
    await repairInstall(installRoot, options)
    await applyPatches(installRoot, options)
    await ensureGoldbergInstall(installRoot, options.nickname, options)
}

async function prepareLaunch(options){
    if(process.platform !== 'win32'){
        throw new Error('Block N Load is only supported on Windows.')
    }

    if(!options?.nickname){
        throw new Error('A nickname is required to launch Block N Load.')
    }

    reportStatus(options, 'preparing', 'Preparing Block N Load..')
    const installRoot = getInstallRoot()

    reportStatus(options, 'validating', 'Validating Block N Load files..')
    const manifestValid = await validateWin64Manifest(installRoot)
    if(!manifestValid){
        await runRepairPipeline(installRoot, options)
    } else {
        await ensureGoldbergInstall(installRoot, options.nickname, options)
    }

    return {
        installRoot,
        server: {
            host: BNL_SERVER_HOST,
            port: BNL_SERVER_PORT
        }
    }
}

async function repairGame(options){
    if(process.platform !== 'win32'){
        throw new Error('Block N Load is only supported on Windows.')
    }

    if(!options?.nickname){
        throw new Error('A nickname is required to repair Block N Load.')
    }

    reportStatus(options, 'preparing', 'Preparing Block N Load..')
    const installRoot = getInstallRoot()
    await runRepairPipeline(installRoot, options)

    return {
        installRoot,
        server: {
            host: BNL_SERVER_HOST,
            port: BNL_SERVER_PORT
        }
    }
}

function launchGame(installRoot){
    const exePath = path.join(installRoot, BNL_EXE_RELATIVE_PATH)
    if(!fs.existsSync(exePath)){
        throw new Error('Block N Load executable not found.')
    }
    const child = child_process.spawn(exePath, [], {
        cwd: installRoot,
        detached: ConfigManager.getLaunchDetached()
    })
    if(ConfigManager.getLaunchDetached()){
        child.unref()
    }
    return child
}

module.exports = {
    prepareLaunch,
    launchGame,
    repairGame
}
