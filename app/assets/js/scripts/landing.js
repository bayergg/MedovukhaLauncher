/**
 * Script for landing.ejs
 */
// Requirements
const { URL }                 = require('url')
const net                     = require('net')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')
const BnlManager              = require('./assets/js/bnl/bnlmanager')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const bnl_install_button      = document.getElementById('bnl_install_button')
const bnl_repair_button       = document.getElementById('bnl_repair_button')
const user_text               = document.getElementById('user_text')
const landing_container        = document.getElementById('landingContainer')
const game_select_minecraft    = document.getElementById('gameSelectMinecraft')
const game_select_bnl          = document.getElementById('gameSelectBnl')
let newsButtonAlert
let newsNavigateRight
let newsNavigateLeft
let newsContent
let newsArticleTitle
let newsArticleDate
let newsArticleAuthor
let newsArticleComments
let newsNavigationStatus
let newsArticleContentScrollable
let nELoadSpan

const loggerLanding = LoggerUtil.getLogger('Landing')

const GAME_MINECRAFT = 'minecraft'
const GAME_BNL = 'blocknload'
const OS_PROGRESS_INDETERMINATE = 'indeterminate'
const BNL_SERVER_HOST = '5.175.220.106'
const BNL_SERVER_PORT = 28100
const BNL_SERVER_LABEL = `&#8226; ${BNL_SERVER_HOST}:${BNL_SERVER_PORT}`

function createLaunchState(){
    return {
        loading: false,
        percent: 0,
        detailsText: Lang.queryJS('landing.launchDetails'),
        enabled: false,
        osProgress: null
    }
}

function createNewsState(){
    return {
        active: false,
        glideCount: 0,
        alertShown: false,
        articles: null,
        loadingListener: null,
        status: 'idle',
        currentIndex: 0,
        loaded: false
    }
}

const landingState = {
    [GAME_MINECRAFT]: {
        launch: createLaunchState(),
        serverSelection: {
            label: '&#8226; ' + Lang.queryJS('landing.selectedServer.loading'),
            disabled: false
        },
        serverStatus: {
            label: Lang.queryJS('landing.serverStatus.server'),
            value: Lang.queryJS('landing.serverStatus.offline')
        },
        mojang: {
            essentialHtml: '',
            nonEssentialHtml: '',
            statusColor: MojangRestAPI.statusToHex('grey')
        },
        news: createNewsState()
    },
    [GAME_BNL]: {
        launch: createLaunchState(),
        serverSelection: {
            label: BNL_SERVER_LABEL,
            disabled: false
        },
        serverStatus: {
            label: Lang.queryJS('landing.serverStatus.server'),
            value: Lang.queryJS('landing.serverStatus.offline')
        },
        mojang: {
            essentialHtml: '',
            nonEssentialHtml: '',
            statusColor: MojangRestAPI.statusToHex('grey')
        },
        news: createNewsState()
    }
}

let selectedGame = ConfigManager.getSelectedGame != null ? ConfigManager.getSelectedGame() : GAME_MINECRAFT
if(selectedGame !== GAME_MINECRAFT && selectedGame !== GAME_BNL){
    selectedGame = GAME_MINECRAFT
    if(ConfigManager.setSelectedGame != null){
        ConfigManager.setSelectedGame(selectedGame)
        ConfigManager.save()
    }
}

function getGameState(gameKey){
    return landingState[gameKey]
}

function getNewsState(gameKey){
    return landingState[gameKey].news
}

function isGameActive(gameKey){
    return selectedGame === gameKey
}

/* Launch Progress Wrapper Functions */

function applyOsProgress(gameKey){
    if(!isGameActive(gameKey)){
        return
    }
    const osProgress = getGameState(gameKey).launch.osProgress
    if(osProgress === OS_PROGRESS_INDETERMINATE){
        remote.getCurrentWindow().setProgressBar(2)
    } else if(typeof osProgress === 'number'){
        remote.getCurrentWindow().setProgressBar(osProgress/100)
    } else {
        remote.getCurrentWindow().setProgressBar(-1)
    }
}

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 * @param {string} gameKey The game key being updated.
 */
function toggleLaunchArea(loading, gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.loading = loading
    if(!isGameActive(gameKey)){
        return
    }
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 * @param {string} gameKey The game key being updated.
 */
function setLaunchDetails(details, gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.detailsText = details
    if(isGameActive(gameKey)){
        launch_details_text.innerHTML = details
    }
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 * @param {string} gameKey The game key being updated.
 */
function setLaunchPercentage(percent, gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.percent = percent
    if(!isGameActive(gameKey)){
        return
    }
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 * @param {string} gameKey The game key being updated.
 */
function setDownloadPercentage(percent, gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.osProgress = percent
    setLaunchPercentage(percent, gameKey)
    applyOsProgress(gameKey)
}

function setDownloadIndeterminate(gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.osProgress = OS_PROGRESS_INDETERMINATE
    applyOsProgress(gameKey)
}

function clearDownloadProgress(gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.osProgress = null
    applyOsProgress(gameKey)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 * @param {string} gameKey The game key being updated.
 */
function setLaunchEnabled(val, gameKey = selectedGame){
    const state = getGameState(gameKey)
    state.launch.enabled = val
    if(isGameActive(gameKey)){
        document.getElementById('launch_button').disabled = !val
    }
}

function renderLaunchState(gameKey){
    if(!isGameActive(gameKey)){
        return
    }
    const state = getGameState(gameKey)
    if(state.launch.loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
    launch_details_text.innerHTML = state.launch.detailsText
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', state.launch.percent)
    launch_progress_label.innerHTML = state.launch.percent + '%'
    document.getElementById('launch_button').disabled = !state.launch.enabled
    applyOsProgress(gameKey)
}

function setServerSelectionState(gameKey, { label, disabled }){
    const state = getGameState(gameKey)
    if(label != null){
        state.serverSelection.label = label
    }
    if(typeof disabled === 'boolean'){
        state.serverSelection.disabled = disabled
    }
    if(isGameActive(gameKey)){
        server_selection_button.innerHTML = state.serverSelection.label
        server_selection_button.disabled = state.serverSelection.disabled
    }
}

function renderServerStatus(gameKey, fade = false){
    if(!isGameActive(gameKey)){
        return
    }
    const status = getGameState(gameKey).serverStatus
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = status.label
            document.getElementById('player_count').innerHTML = status.value
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = status.label
        document.getElementById('player_count').innerHTML = status.value
    }
}

function renderMojangStatus(gameKey){
    if(gameKey !== GAME_MINECRAFT || !isGameActive(gameKey)){
        return
    }
    const mojang = getGameState(gameKey).mojang
    document.getElementById('mojangStatusEssentialContainer').innerHTML = mojang.essentialHtml
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = mojang.nonEssentialHtml
    document.getElementById('mojang_status_icon').style.color = mojang.statusColor
}

function renderNewsAlert(gameKey){
    if(!isGameActive(gameKey)){
        return
    }
    if(newsButtonAlert == null){
        return
    }
    const news = getNewsState(gameKey)
    if(news.alertShown){
        $(newsButtonAlert).fadeIn(250)
    } else {
        $(newsButtonAlert).hide()
    }
}

function renderLandingForGame(gameKey){
    renderLaunchState(gameKey)
    setServerSelectionState(gameKey, {})
    renderServerStatus(gameKey)
    renderMojangStatus(gameKey)
    renderNewsAlert(gameKey)
    renderNewsState(gameKey, { animate: false })
}

function updateGameSelectionUI(){
    if(landing_container != null){
        landing_container.setAttribute('data-game', selectedGame)
    }
    if(game_select_minecraft != null){
        if(selectedGame === GAME_MINECRAFT){
            game_select_minecraft.setAttribute('selected', true)
        } else {
            game_select_minecraft.removeAttribute('selected')
        }
    }
    if(game_select_bnl != null){
        if(selectedGame === GAME_BNL){
            game_select_bnl.setAttribute('selected', true)
        } else {
            game_select_bnl.removeAttribute('selected')
        }
    }
}

function updateLaunchControlsForGame(gameKey = selectedGame){
    if(gameKey === GAME_BNL){
        setServerSelectionState(gameKey, { label: BNL_SERVER_LABEL, disabled: true })
        setLaunchEnabled(ConfigManager.getSelectedAccount() != null, gameKey)
    } else {
        setServerSelectionState(gameKey, { disabled: false })
        setLaunchEnabled(ConfigManager.getSelectedServer() != null, gameKey)
    }
}

function closeNewsIfActive(gameKey){
    const news = getNewsState(gameKey)
    if(!news.active){
        return
    }
    $('#landingMain *').removeAttr('tabindex')
    $('#newsContainer *').attr('tabindex', '-1')
    slide_(false, gameKey)
    news.active = false
}

function setSelectedGame(game){
    if(game === selectedGame){
        return
    }
    const previousGame = selectedGame
    closeNewsIfActive(previousGame)

    selectedGame = game
    if(ConfigManager.setSelectedGame != null){
        ConfigManager.setSelectedGame(game)
        ConfigManager.save()
    }
    updateGameSelectionUI()
    updateLaunchControlsForGame(game)
    renderLandingForGame(game)
    if(!getNewsState(game).loaded){
        initNews(game)
    }
    if(game === GAME_MINECRAFT){
        refreshMinecraftServerStatus()
        refreshMojangStatuses()
    } else {
        refreshBnlServerStatus()
    }
}

if(game_select_minecraft != null){
    game_select_minecraft.addEventListener('click', () => {
        setSelectedGame(GAME_MINECRAFT)
    })
}

if(game_select_bnl != null){
    game_select_bnl.addEventListener('click', () => {
        setSelectedGame(GAME_BNL)
    })
}

updateGameSelectionUI()
updateLaunchControlsForGame(GAME_MINECRAFT)
updateLaunchControlsForGame(GAME_BNL)
renderLandingForGame(selectedGame)

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        if(selectedGame === GAME_BNL){
            await launchBlockNLoad()
            return
        }
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions, true, GAME_MINECRAFT)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'), GAME_MINECRAFT)
            toggleLaunchArea(true, GAME_MINECRAFT)
            setLaunchPercentage(0, GAME_MINECRAFT)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync(true, GAME_MINECRAFT)

            } else {
                await asyncSystemScan(server.effectiveJavaOptions, true, GAME_MINECRAFT)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'), GAME_MINECRAFT)
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/body/${authUser.uuid}/right')`
        }
    }
    user_text.innerHTML = username
    updateLaunchControlsForGame(GAME_MINECRAFT)
    updateLaunchControlsForGame(GAME_BNL)
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    const label = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    setServerSelectionState(GAME_MINECRAFT, { label })
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null, GAME_MINECRAFT)
}

async function chooseBnlInstallRoot(){
    const options = {
        properties: ['openDirectory'],
        title: Lang.queryJS('landing.bnlInstallDialogTitle')
    }
    const currentRoot = ConfigManager.getBnlInstallRoot?.()
    if(currentRoot != null){
        options.defaultPath = currentRoot
    }
    const res = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), options)
    if(res.canceled){
        return
    }
    const selectedPath = res.filePaths?.[0]
    if(!selectedPath){
        return
    }
    if(ConfigManager.setBnlInstallRoot != null){
        ConfigManager.setBnlInstallRoot(selectedPath)
        ConfigManager.save()
    }
}

// Real text is set in uibinder.js on distributionIndexDone.
setServerSelectionState(GAME_MINECRAFT, { label: '&#8226; ' + Lang.queryJS('landing.selectedServer.loading') })
server_selection_button.onclick = async e => {
    e.target.blur()
    if(selectedGame !== GAME_MINECRAFT){
        return
    }
    await toggleServerSelection(true)
}

if(bnl_install_button != null){
    bnl_install_button.addEventListener('click', async e => {
        e.target.blur()
        if(selectedGame !== GAME_BNL){
            return
        }
        await chooseBnlInstallRoot()
    })
}

if(bnl_repair_button != null){
    bnl_repair_button.addEventListener('click', async e => {
        e.target.blur()
        if(selectedGame !== GAME_BNL){
            return
        }
        await repairBlockNLoad()
    })
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    const mojangState = getGameState(GAME_MINECRAFT).mojang
    mojangState.essentialHtml = tooltipEssentialHTML
    mojangState.nonEssentialHtml = tooltipNonEssentialHTML
    mojangState.statusColor = MojangRestAPI.statusToHex(status)
    renderMojangStatus(GAME_MINECRAFT)
}

const refreshMinecraftServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Minecraft Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    if(serv == null){
        const state = getGameState(GAME_MINECRAFT).serverStatus
        state.label = pLabel
        state.value = pVal
        renderServerStatus(GAME_MINECRAFT, fade)
        return
    }

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    const state = getGameState(GAME_MINECRAFT).serverStatus
    state.label = pLabel
    state.value = pVal
    renderServerStatus(GAME_MINECRAFT, fade)
}

const refreshServerStatus = refreshMinecraftServerStatus

const refreshBnlServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Block N Load Server Status')
    const state = getGameState(GAME_BNL).serverStatus
    state.label = Lang.queryJS('landing.serverStatus.server')
    state.value = Lang.queryJS('landing.serverStatus.offline')

    try {
        const online = await checkBnlServerOnline(BNL_SERVER_HOST, BNL_SERVER_PORT)
        state.value = online ? Lang.queryJS('landing.serverStatus.online') : Lang.queryJS('landing.serverStatus.offline')
    } catch (err) {
        loggerLanding.warn('Unable to refresh Block N Load server status, assuming offline.')
        loggerLanding.debug(err)
    }

    renderServerStatus(GAME_BNL, fade)
}

function checkBnlServerOnline(host, port, timeoutMs = 2000){
    return new Promise(resolve => {
        let settled = false
        const socket = new net.Socket()

        const finish = (online) => {
            if(settled){
                return
            }
            settled = true
            socket.destroy()
            resolve(online)
        }

        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
        socket.connect(Number(port), host)
    })
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let minecraftServerStatusListener = setInterval(() => refreshMinecraftServerStatus(true), 300000)
let bnlServerStatusListener = setInterval(() => refreshBnlServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc, gameKey = selectedGame){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false, gameKey)
    clearDownloadProgress(gameKey)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true, gameKey = GAME_MINECRAFT){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'), gameKey)
    toggleLaunchArea(true, gameKey)
    setLaunchPercentage(0, gameKey)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'), gameKey)
            toggleOverlay(false)
            
            try {
                downloadJava(effectiveJavaOptions, launchAfter, gameKey)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'), gameKey)
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false, gameKey)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter, gameKey)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync(true, gameKey)
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true, gameKey = GAME_MINECRAFT) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100), gameKey)
    })
    setDownloadPercentage(100, gameKey)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    setDownloadIndeterminate(gameKey)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr, gameKey)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr, gameKey)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    clearDownloadProgress(gameKey)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'), gameKey)

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter, gameKey)

}

async function launchBlockNLoad(){
    const gameKey = GAME_BNL
    const authUser = ConfigManager.getSelectedAccount()
    if(authUser == null){
        showLaunchFailure(Lang.queryJS('landing.bnlNoAccountTitle'), Lang.queryJS('landing.bnlNoAccountText'), gameKey)
        return
    }

    const nickname = authUser.displayName != null ? authUser.displayName.trim() : authUser.username.trim()

    const updateProgress = (percent) => {
        if(percent == null || Number.isNaN(percent)){
            setDownloadIndeterminate(gameKey)
            return
        }
        const clamped = Math.min(100, Math.max(0, Math.trunc(percent)))
        setDownloadPercentage(clamped, gameKey)
    }

    try {
        setLaunchDetails(Lang.queryJS('landing.bnlPreparing'), gameKey)
        toggleLaunchArea(true, gameKey)
        setLaunchPercentage(0, gameKey)
        setDownloadIndeterminate(gameKey)

        const result = await BnlManager.prepareLaunch({
            nickname,
            onStatus: (message) => setLaunchDetails(message, gameKey),
            onProgress: updateProgress,
            messages: {
                preparing: Lang.queryJS('landing.bnlPreparing'),
                validating: Lang.queryJS('landing.bnlValidating'),
                downloading: Lang.queryJS('landing.bnlDownloading'),
                verifying: Lang.queryJS('landing.bnlVerifyingUpdate'),
                committing: Lang.queryJS('landing.bnlCommittingUpdate'),
                patching: Lang.queryJS('landing.bnlPatching'),
                goldberg: Lang.queryJS('landing.bnlGoldberg')
            }
        })

        setLaunchDetails(Lang.queryJS('landing.bnlLaunching'), gameKey)

        const bnlProc = BnlManager.launchGame(result.installRoot)
        if(bnlProc != null){
            bnlProc.stdout?.on('data', (data) => {
                data.trim().split('\n').forEach(x => console.log(`\x1b[32m[BlockNLoad]\x1b[0m ${x}`))
            })
            bnlProc.stderr?.on('data', (data) => {
                data.trim().split('\n').forEach(x => console.log(`\x1b[31m[BlockNLoad]\x1b[0m ${x}`))
            })
        }

        setLaunchDetails(Lang.queryJS('landing.bnlDoneEnjoy'), gameKey)
        toggleLaunchArea(false, gameKey)
    } catch (err) {
        loggerLanding.error('Block N Load launch failed.', err)
        showLaunchFailure(Lang.queryJS('landing.bnlErrorTitle'), err.displayable || err.message || Lang.queryJS('landing.bnlErrorText'), gameKey)
    } finally {
        clearDownloadProgress(gameKey)
    }
}

async function repairBlockNLoad(){
    const gameKey = GAME_BNL
    const authUser = ConfigManager.getSelectedAccount()
    if(authUser == null){
        showLaunchFailure(Lang.queryJS('landing.bnlNoAccountTitle'), Lang.queryJS('landing.bnlNoAccountText'), gameKey)
        return
    }

    const nickname = authUser.displayName != null ? authUser.displayName.trim() : authUser.username.trim()

    const updateProgress = (percent) => {
        if(percent == null || Number.isNaN(percent)){
            setDownloadIndeterminate(gameKey)
            return
        }
        const clamped = Math.min(100, Math.max(0, Math.trunc(percent)))
        setDownloadPercentage(clamped, gameKey)
    }

    try {
        setLaunchDetails(Lang.queryJS('landing.bnlPreparing'), gameKey)
        toggleLaunchArea(true, gameKey)
        setLaunchPercentage(0, gameKey)
        setDownloadIndeterminate(gameKey)

        await BnlManager.repairGame({
            nickname,
            onStatus: (message) => setLaunchDetails(message, gameKey),
            onProgress: updateProgress,
            messages: {
                preparing: Lang.queryJS('landing.bnlPreparing'),
                validating: Lang.queryJS('landing.bnlValidating'),
                downloading: Lang.queryJS('landing.bnlDownloading'),
                verifying: Lang.queryJS('landing.bnlVerifyingUpdate'),
                committing: Lang.queryJS('landing.bnlCommittingUpdate'),
                patching: Lang.queryJS('landing.bnlPatching'),
                goldberg: Lang.queryJS('landing.bnlGoldberg')
            }
        })

        setLaunchDetails(Lang.queryJS('landing.bnlRepairComplete'), gameKey)
        toggleLaunchArea(false, gameKey)
    } catch (err) {
        loggerLanding.error('Block N Load repair failed.', err)
        showLaunchFailure(Lang.queryJS('landing.bnlErrorTitle'), err.displayable || err.message || Lang.queryJS('landing.bnlErrorText'), gameKey)
    } finally {
        clearDownloadProgress(gameKey)
    }
}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

async function dlAsync(login = true, gameKey = GAME_MINECRAFT) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'), gameKey)

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'), gameKey)
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'), gameKey)
    toggleLaunchArea(true, gameKey)
    setLaunchPercentage(0, gameKey)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'), gameKey)
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'), gameKey)
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'), gameKey)
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent, gameKey)
        })
        setLaunchPercentage(100, gameKey)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'), gameKey)
        return
    }
    

    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'), gameKey)
        setLaunchPercentage(0, gameKey)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent, gameKey)
            })
            setDownloadPercentage(100, gameKey)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'), gameKey)
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    clearDownloadProgress(gameKey)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'), gameKey)

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'), gameKey)

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false, gameKey)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'), gameKey)
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'), gameKey)

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'), gameKey)

        }
    }

}

/**
 * News Loading Functions
 */

// DOM Cache
newsContent                   = document.getElementById('newsContent')
newsArticleTitle              = document.getElementById('newsArticleTitle')
newsArticleDate               = document.getElementById('newsArticleDate')
newsArticleAuthor             = document.getElementById('newsArticleAuthor')
newsArticleComments           = document.getElementById('newsArticleComments')
newsNavigationStatus          = document.getElementById('newsNavigationStatus')
newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
nELoadSpan                    = document.getElementById('nELoadSpan')
newsButtonAlert               = document.getElementById('newsButtonAlert')
newsNavigateRight             = document.getElementById('newsNavigateRight')
newsNavigateLeft              = document.getElementById('newsNavigateLeft')

/**
 * Show the news UI via a slide animation.
 * 
 * @param {boolean} up True to slide up, otherwise false. 
 */
function slide_(up, gameKey = selectedGame){
    const state = getNewsState(gameKey)
    const lCUpper = document.querySelector('#landingMain > #upper')
    const lCLLeft = document.querySelector('#landingMain > #lower > #left')
    const lCLCenter = document.querySelector('#landingMain > #lower > #center')
    const lCLRight = document.querySelector('#landingMain > #lower > #right')
    const newsBtn = document.querySelector('#landingMain > #lower > #center #content')
    const landingContainer = document.getElementById('landingMain')
    const newsContainer = document.querySelector('#landingMain > #newsContainer')

    state.glideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        newsBtn.style.top = '130vh'
        newsContainer.style.top = '0px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(state.glideCount === 1){
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = 'none'
            }
            state.glideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            state.glideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        newsBtn.style.top = '10px'
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    const state = getNewsState(selectedGame)
    // Toggle tabbing.
    if(state.active){
        $('#landingMain *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingMain *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(state.alertShown){
            $('#newsButtonAlert').fadeOut(2000)
            state.alertShown = false
            ConfigManager.setNewsCacheDismissed(true, selectedGame)
            ConfigManager.save()
        }
    }
    slide_(!state.active, selectedGame)
    state.active = !state.active
}

// Array to store article meta per game is stored in landingState.

/**
 * Set the news loading animation.
 * 
 * @param {string} gameKey The game key being updated.
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(gameKey, val){
    const state = getNewsState(gameKey)
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        if(isGameActive(gameKey)){
            nELoadSpan.innerHTML = nLStr + dotStr
        }
        if(state.loadingListener != null){
            clearInterval(state.loadingListener)
        }
        state.loadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            if(isGameActive(gameKey)){
                nELoadSpan.innerHTML = nLStr + dotStr
            }
        }, 750)
    } else {
        if(state.loadingListener != null){
            clearInterval(state.loadingListener)
            state.loadingListener = null
        }
    }
}

function switchNewsArticle(forward){
    const state = getNewsState(selectedGame)
    if(state.articles == null || state.articles.length === 0){
        return
    }
    const currentIndex = Number.isInteger(state.currentIndex) ? state.currentIndex : 0
    const maxIndex = state.articles.length - 1
    const nextIndex = forward
        ? (currentIndex >= maxIndex ? 0 : currentIndex + 1)
        : (currentIndex <= 0 ? maxIndex : currentIndex - 1)
    displayArticle(state.articles[nextIndex], nextIndex + 1, selectedGame)
}

if(newsNavigateRight != null){
    newsNavigateRight.onclick = () => switchNewsArticle(true)
}
if(newsNavigateLeft != null){
    newsNavigateLeft.onclick = () => switchNewsArticle(false)
}

async function renderNewsState(gameKey, { animate = true } = {}){
    if(!isGameActive(gameKey)){
        return
    }
    if(newsContent == null || newsArticleTitle == null || newsArticleContentScrollable == null){
        return
    }
    const state = getNewsState(gameKey)

    const show = async (selector) => {
        if(animate){
            await $(selector).fadeIn(250).promise()
        } else {
            $(selector).show()
        }
    }

    const hide = async (selector) => {
        if(animate){
            await $(selector).fadeOut(250).promise()
        } else {
            $(selector).hide()
        }
    }

    if(state.status === 'ready' && state.articles != null && state.articles.length > 0){
        await hide('#newsErrorContainer')
        let index = Number.isInteger(state.currentIndex) ? state.currentIndex : 0
        if(index < 0 || index >= state.articles.length){
            index = 0
        }
        displayArticle(state.articles[index], index + 1, gameKey)
        await show('#newsContent')
        return
    }

    await hide('#newsContent')
    await show('#newsErrorContainer')
    await hide('#newsErrorLoading')
    await hide('#newsErrorFailed')
    await hide('#newsErrorNone')

    if(state.status === 'failed'){
        await show('#newsErrorFailed')
    } else if(state.status === 'none'){
        await show('#newsErrorNone')
    } else {
        await show('#newsErrorLoading')
    }
}

// Bind retry button.
document.getElementById('newsErrorRetry').onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews(selectedGame)
        $('#newsErrorLoading').fadeIn(250)
    })
}

if(newsArticleContentScrollable != null){
    newsArticleContentScrollable.onscroll = (e) => {
        if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
            newsContent.setAttribute('scrolled', '')
        } else {
            newsContent.removeAttribute('scrolled')
        }
    }
}

/**
 * Reload the news without restarting.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(gameKey = selectedGame){
    return new Promise((resolve, reject) => {
        if(isGameActive(gameKey)){
            $('#newsContent').fadeOut(250, () => {
                $('#newsErrorLoading').fadeIn(250)
                initNews(gameKey).then(() => {
                    resolve()
                })
            })
        } else {
            initNews(gameKey).then(() => resolve())
        }
    })
}

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(gameKey){
    const state = getNewsState(gameKey)
    state.alertShown = true
    if(isGameActive(gameKey)){
        $(newsButtonAlert).fadeIn(250)
    }
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(gameKey = selectedGame){

    const state = getNewsState(gameKey)
    state.alertShown = false
    setNewsLoading(gameKey, true)

    const news = await loadNews(gameKey)

    state.articles = news?.articles || null

    if(state.articles == null){
        // News Loading Failed
        state.status = 'failed'
        setNewsLoading(gameKey, false)

    } else if(state.articles.length === 0) {
        // No News Articles
        state.status = 'none'
        setNewsLoading(gameKey, false)

        ConfigManager.setNewsCache(gameKey, {
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()
    } else {
        // Success
        state.status = 'ready'
        setNewsLoading(gameKey, false)

        if(gameKey === GAME_MINECRAFT){
            const lN = state.articles[0]
            const cached = ConfigManager.getNewsCache(gameKey)
            let newHash = await digestMessage(lN.content)
            let newDate = new Date(lN.date)
            let isNew = false

            if(cached.date != null && cached.content != null){

                if(new Date(cached.date) >= newDate){

                    // Compare Content
                    if(cached.content !== newHash){
                        isNew = true
                        showNewsAlert(gameKey)
                    } else {
                        if(!cached.dismissed){
                            isNew = true
                            showNewsAlert(gameKey)
                        }
                    }

                } else {
                    isNew = true
                    showNewsAlert(gameKey)
                }

            } else {
                isNew = true
                showNewsAlert(gameKey)
            }

            if(isNew){
                ConfigManager.setNewsCache(gameKey, {
                    date: newDate.getTime(),
                    content: newHash,
                    dismissed: false
                })
                ConfigManager.save()
            }
        } else {
            state.alertShown = false
        }
    }

    state.loaded = true
    await renderNewsState(gameKey)

}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    const state = getNewsState(selectedGame)
    if(state.active){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 * 
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index, gameKey = selectedGame){
    const state = getNewsState(gameKey)
    if(newsArticleTitle == null || newsArticleContentScrollable == null || newsNavigationStatus == null){
        return
    }
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = 'by ' + articleObject.author
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: state.articles.length})
    newsContent.setAttribute('article', index-1)
    state.currentIndex = index - 1
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(gameKey = selectedGame){

    if(gameKey === GAME_BNL){
        return {
            articles: []
        }
    }

    const distroData = await DistroAPI.getDistribution()
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed provided.')
        return null
    }

    const promise = new Promise((resolve, reject) => {
        
        const newsFeed = distroData.rawDistribution.rss
        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date.
                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Fix relative links in content.
                    let content = el.find('content\\:encoded').text()
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}
