const coreRoot = '../../../vendor/helios-core/dist'

module.exports = {
    ...require(coreRoot),
    common: require(coreRoot + '/common'),
    dl: require(coreRoot + '/dl'),
    java: require(coreRoot + '/java'),
    microsoft: require(coreRoot + '/microsoft'),
    mojang: require(coreRoot + '/mojang')
}
