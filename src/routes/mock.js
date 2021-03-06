const { URL } = require('url')
const router = require('./router')
const { Repository, Interface, Property, QueryInclude } = require('../models')
const attributes = { exclude: [] }
const Tree = require('./utils/tree')
const pt = require('node-print').pt
const beautify = require('js-beautify').js_beautify

// 检测是否存在重复接口，会在返回的插件 JS 中提示。同时也会在编辑器中提示。
const parseDuplicatedInterfaces = (repository) => {
  let counter = {}
  for (let itf of repository.interfaces) {
    let key = `${itf.method} ${itf.url}`
    counter[key] = [...(counter[key] || []), { id: itf.id, method: itf.method, url: itf.url }]
  }
  let duplicated = []
  for (let key in counter) {
    if (counter[key].length > 1) {
      duplicated.push(counter[key])
    }
  }
  return duplicated
}
const generatePlugin = (protocol, host, repository) => {
  // DONE 2.3 protocol 错误，应该是 https
  let duplicated = parseDuplicatedInterfaces(repository)
  let editor = `${protocol}://rap2.alibaba-inc.com/repository/editor?id=${repository.id}`
  let result = `
/**
 * 仓库    #${repository.id} ${repository.name}
 * 在线编辑 ${editor}
 * 仓库数据 ${protocol}://${host}/repository/get?id=${repository.id}
 * 请求地址 ${protocol}://${host}/app/mock/${repository.id}/:method/:url
 *    或者 ${protocol}://${host}/app/mock/template/:interfaceId
 *    或者 ${protocol}://${host}/app/mock/data/:interfaceId
 */
;(function(){
  let repositoryId = ${repository.id}
  let interfaces = [
    ${repository.interfaces.map(itf =>
      `{ id: ${itf.id}, name: '${itf.name}', method: '${itf.method}', url: '${itf.url}', 
      request: ${JSON.stringify(itf.request)}, 
      response: ${JSON.stringify(itf.response)} }`
    ).join(',\n    ')}
  ]
  ${duplicated.length ? `console.warn('检测到重复接口，请访问 ${editor} 修复警告！')\n` : ''}
  let RAP = window.RAP || {
    protocol: '${protocol}',
    host: '${host}',
    interfaces: {}
  }
  RAP.interfaces[repositoryId] = interfaces
  window.RAP = RAP
})();`
  return beautify(result, { indent_size: 2 })
}

router.get('/app/plugin/:repositories', async (ctx, next) => {
  let repositoryIds = new Set(ctx.params.repositories.split(',').map(item => +item).filter(item => item)) // _.uniq() => Set
  let result = []
  for (let id of repositoryIds) {
    let repository = await Repository.findById(id, {
      attributes: { exclude: [] },
      include: [
        QueryInclude.Creator,
        QueryInclude.Owner,
        QueryInclude.Locker,
        QueryInclude.Members,
        QueryInclude.Organization,
        QueryInclude.Collaborators
      ]
    })
    if (!repository) continue
    if (repository.collaborators) {
      repository.collaborators.map(item => {
        repositoryIds.add(item.id)
      })
    }
    console.log(repositoryIds)
    repository.interfaces = await Interface.findAll({
      attributes: { exclude: [] },
      where: {
        repositoryId: repository.id
      },
      include: [
        QueryInclude.Properties
      ]
    })
    repository.interfaces.forEach(itf => {
      itf.request = Tree.ArrayToTreeToTemplate(itf.properties.filter(item => item.scope === 'request'))
      itf.response = Tree.ArrayToTreeToTemplate(itf.properties.filter(item => item.scope === 'response'))
    })
    // 修复 协议总是 http
    // https://lark.alipay.com/login-session/unity-login/xp92ap
    let protocol = ctx.headers['x-client-scheme'] || ctx.protocol
    result.push(generatePlugin(protocol, ctx.host, repository))
  }

  ctx.type = 'application/x-javascript'
  ctx.body = result.join('\n')
})

// /app/mock/:repository/:method/:url
// X DONE 2.2 支持 GET POST PUT DELETE 请求
// DONE 2.2 忽略请求地址中的前缀斜杠
// DONE 2.3 支持所有类型的请求，这样从浏览器中发送跨越请求时不需要修改 method
router.all('/app/mock/(\\d+)/(\\w+)/(.+)', async (ctx, next) => {
  ctx.app.counter.mock++

  let [ repositoryId, method, url ] = [ctx.params[0], ctx.params[1], ctx.params[2]]

  let urlWithoutPrefixSlash = /(\/)?(.*)/.exec(url)[2]
  let urlWithoutSearch
  try {
    let urlParts = new URL(url)
    urlWithoutSearch = `${urlParts.origin}${urlParts.pathname}`
  } catch (e) {
    urlWithoutSearch = url
  }
  // console.log([urlWithoutPrefixSlash, '/' + urlWithoutPrefixSlash, urlWithoutSearch])
  // DONE 2.3 腐烂的 KISSY
  // KISSY 1.3.2 会把路径中的 // 替换为 /。在浏览器端拦截跨域请求时，需要 encodeURIComponent(url) 以防止 http:// 被替换为 http:/。但是同时也会把参数一起编码，导致 route 的 url 部分包含了参数。
  // 所以这里重新解析一遍！！！

  let repository = await Repository.findById(repositoryId)
  let collaborators = await repository.getCollaborators()

  let itf = await Interface.findOne({
    attributes,
    where: {
      repositoryId: [repositoryId, ...collaborators.map(item => item.id)],
      method,
      url: [urlWithoutPrefixSlash, '/' + urlWithoutPrefixSlash, urlWithoutSearch]
    }
  })

  if (!itf) {
    ctx.body = {}
    return
  }

  let interfaceId = itf.id
  let properties = await Property.findAll({
    attributes,
    where: { interfaceId, scope: 'response' }
  })
  properties = properties.map(item => item.toJSON())
  // pt(properties)

  // DONE 2.2 支持引用请求参数
  let requestProperties = await Property.findAll({
    attributes,
    where: { interfaceId, scope: 'request' }
  })
  requestProperties = requestProperties.map(item => item.toJSON())
  let requestData = Tree.ArrayToTreeToTemplateToData(requestProperties)
  Object.assign(requestData, ctx.query)

  let data = Tree.ArrayToTreeToTemplateToData(properties, requestData)
  ctx.type = 'json'
  ctx.body = JSON.stringify(data, null, 2)
})

// DONE 2.2 支持获取请求参数的模板、数据、Schema
router.get('/app/mock/template/:interfaceId', async (ctx, next) => {
  ctx.app.counter.mock++
  let { interfaceId } = ctx.params
  let { scope = 'response' } = ctx.query
  let properties = await Property.findAll({
    attributes,
    where: { interfaceId, scope }
  })
  pt(properties.map(item => item.toJSON()))
  let template = Tree.ArrayToTreeToTemplate(properties)
  ctx.type = 'json'
  ctx.body = Tree.stringifyWithFunctonAndRegExp(template)
  // ctx.body = template
  // ctx.body = JSON.stringify(template, null, 2)
})

router.get('/app/mock/data/:interfaceId', async (ctx, next) => {
  ctx.app.counter.mock++
  let { interfaceId } = ctx.params
  let { scope = 'response' } = ctx.query
  let properties = await Property.findAll({
    attributes,
    where: { interfaceId, scope }
  })
  properties = properties.map(item => item.toJSON())
  // pt(properties)

  // DONE 2.2 支持引用请求参数
  let requestProperties = await Property.findAll({
    attributes,
    where: { interfaceId, scope: 'request' }
  })
  requestProperties = requestProperties.map(item => item.toJSON())
  let requestData = Tree.ArrayToTreeToTemplateToData(requestProperties)
  Object.assign(requestData, ctx.query)

  let data = Tree.ArrayToTreeToTemplateToData(properties, requestData)
  ctx.type = 'json'
  ctx.body = JSON.stringify(data, null, 2)
})

router.get('/app/mock/schema/:interfaceId', async (ctx, next) => {
  ctx.app.counter.mock++
  let { interfaceId } = ctx.params
  let { scope = 'response' } = ctx.query
  let properties = await Property.findAll({
    attributes,
    where: { interfaceId, scope }
  })
  pt(properties.map(item => item.toJSON()))
  properties = properties.map(item => item.toJSON())
  let schema = Tree.ArrayToTreeToTemplateToJSONSchema(properties)
  ctx.type = 'json'
  ctx.body = Tree.stringifyWithFunctonAndRegExp(schema)
})

router.get('/app/mock/tree/:interfaceId', async (ctx, next) => {
  ctx.app.counter.mock++
  let { interfaceId } = ctx.params
  let { scope = 'response' } = ctx.query
  let properties = await Property.findAll({
    attributes,
    where: { interfaceId, scope }
  })
  pt(properties.map(item => item.toJSON()))
  properties = properties.map(item => item.toJSON())
  let tree = Tree.ArrayToTree(properties)
  ctx.type = 'json'
  ctx.body = Tree.stringifyWithFunctonAndRegExp(tree)
})
