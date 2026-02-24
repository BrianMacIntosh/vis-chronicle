
const mypath = require("./mypath.js")
const fs = require('fs');
const nodepath = require('node:path');
const globalData = require("./global-data.json")
const assert = require('node:assert/strict')
const SparqlBuilder = require("./sparql-builder.js")

const wikidata = module.exports = {

	inputSpec: null,
	verboseLogging: false,

	/**
	 * 
	 */
	cache: {},

	/**
	 * Caches results for path queries, using the path as the key.
	 */
	pathCache: {},

	skipCache: false,
	cacheBuster: undefined,

	/**
	 * Relative path to the term cache file.
	 */
	termCacheFile: "intermediate/wikidata-term-cache.json",

	/**
	 * Relative path to the path cache file.
	 */
	pathCacheFile: "intermediate/wikidata-path-cache.json",

	sparqlUrl: "https://query.wikidata.org/sparql",
	lang: "en,mul",

	rankDeprecated: "http://wikiba.se/ontology#DeprecatedRank",
	rankNormal: "http://wikiba.se/ontology#NormalRank",
	rankPreferred: "http://wikiba.se/ontology#PreferredRank",

	pathQueryRegex: /^(Q[0-9]+(?::P[0-9]+)?(?::Q[0-9]+:P[0-9]+)?)((?:[\+>](?:[A-Za-z]+(?:![0-9]+)?|P\-?[0-9A-Z]+)+)*)$/,

	initialize: function()
	{
		const chroniclePackage = require("../package.json")
		this.options = {
			method: 'POST',
			headers: {
				'User-Agent': `vis-chronicle/${chroniclePackage.version} (https://github.com/BrianMacIntosh/vis-chronicle) Node.js/${process.version}`,
				'Content-Type': 'application/sparql-query',
				'Accept': 'application/sparql-results+json'
			}
		}
	},

	setLang: function(inLang)
	{
		//TODO: escape
		this.lang = inLang
	},

	readInputSpec: async function(path)
	{
		const pathStat = await fs.promises.stat(path)
		if (pathStat.isDirectory())
		{
			// read multi-file config
			this.inputSpec = {}

			const files = await fs.promises.readdir(path)
			for (const fileName of files)
			{
				if (fileName.endsWith(".json"))
				{
					const contents = await fs.promises.readFile(nodepath.join(path, fileName))
					const specPart = JSON.parse(contents)
					for (const key in specPart)
					{
						if (specPart[key] instanceof Array)
						{
							if (this.inputSpec[key])
							{
								this.inputSpec[key].push(...specPart[key])
							}
							else
							{
								this.inputSpec[key] = specPart[key]
							}
						}
						else if (this.inputSpec[key])
						{
							throw `Key '${key}' appears in multiple input spec files.`
						}
						else
						{
							this.inputSpec[key] = specPart[key]
						}
					}
				}
			}
		}
		else
		{
			// read single-file config
			const contents = await fs.promises.readFile(path)
			this.inputSpec = JSON.parse(contents)
		}

		// assign default values
		if (!this.inputSpec.chronicle)
			this.inputSpec.chronicle = {}

		const chronicleOptions = this.inputSpec.chronicle
		if (chronicleOptions.defaultLabel === undefined)
			chronicleOptions.defaultLabel = '<a target="_blank" href="https://www.wikidata.org/wiki/{_QID}">{_LABEL}</a>'
		if (chronicleOptions.maxUncertainTimePrecision === undefined)
			chronicleOptions.maxUncertainTimePrecision = 10
		if (chronicleOptions.shareSuccessiveUncertainty === undefined)
			chronicleOptions.shareSuccessiveUncertainty = true
	},

	readCache: async function()
	{
		try
		{
			const contents = await fs.promises.readFile(this.termCacheFile)
			this.cache = JSON.parse(contents)
		}
		catch
		{
			// cache doesn't exist or is invalid; continue without it
		}

		try
		{
			const contents = await fs.promises.readFile(this.pathCacheFile)
			this.pathCache = JSON.parse(contents)
		}
		catch
		{
			// cache doesn't exist or is invalid; continue without it
		}
	},

	writeCache: async function()
	{
		await mypath.ensureDirectoryForFile(this.termCacheFile)

		fs.writeFile(this.termCacheFile, JSON.stringify(this.cache), err => {
			if (err) {
				console.error(`Error writing wikidata term cache:`)
				console.error(err)
			}
		})

		await mypath.ensureDirectoryForFile(this.pathCacheFile)

		fs.writeFile(this.pathCacheFile, JSON.stringify(this.pathCache), err => {
			if (err) {
				console.error(`Error writing wikidata path cache:`)
				console.error(err)
			}
		})
	},

	getQueryTemplate: function(templateName, templateSetName)
	{
		assert(templateName)
		assert(templateSetName)
		if (this.inputSpec[templateSetName] && this.inputSpec[templateSetName][templateName])
		{
			return this.inputSpec[templateSetName][templateName]
		}
		else if (globalData && globalData[templateSetName] && globalData[templateSetName][templateName])
		{
			return globalData[templateSetName][templateName]
		}
		else
		{
			return undefined
		}
	},

	postprocessQueryTerm: function(context, term, item)
	{
		if (!term)
		{
			return term;
		}

		// replace query wildcards
		for (const key in item)
		{
			var insertValue = item[key]
			if (typeof insertValue === "string" && insertValue.startsWith("Q"))
				insertValue = "wd:" + insertValue
			term = term.replaceAll(`{${key}}`, insertValue)
		}

		// detect unreplaced wildcards
		//TODO:

		// terminate term
		if (!term.trim().endsWith("."))
		{
			term += "."
		}

		return term
	},

	// Dereferences the query term if it's a pointer to a template.
	// Expects simple string terms (start or end)
	getQueryTermHelper: function(inQueryTerm, item, tempateSetName)
	{
		var queryTerm

		if (inQueryTerm.startsWith("#"))
		{
			const templateName = inQueryTerm.substring(1).trim()
			var queryTemplate = this.getQueryTemplate(templateName, tempateSetName);
			if (queryTemplate)
			{
				queryTerm = queryTemplate
			}
			else
			{
				throw `Query template '${templateName}' not found (on item ${item.id}).`
			}
		}
		else
		{
			queryTerm = inQueryTerm
		}

		//TODO: validate query has required wildcards
		
		queryTerm = this.postprocessQueryTerm(inQueryTerm, queryTerm, item)
		return queryTerm
	},

	// Dereferences the query term if it's a pointer to a template.
	// Expects item-generating terms
	getItemQueryTerm: function(queryTerm, item)
	{
		return this.getQueryTermHelper(queryTerm, item, "itemQueryTemplates")
	},

	// Dereferences the query term if it's a pointer to a template.
	getValueQueryTerm: function(inQueryTerm, item)
	{
		var queryTerm

		if (inQueryTerm.startsWith && inQueryTerm.startsWith("#"))
		{
			const templateName = inQueryTerm.substring(1).trim()
			var queryTemplate = this.getQueryTemplate(templateName, "queryTemplates");
			if (queryTemplate)
			{
				queryTerm = queryTemplate
			}
			else
			{
				throw `Query template '${templateName}' not found (on item ${item.id}).`
			}
		}
		else
		{
			queryTerm = inQueryTerm
		}

		if (typeof queryTerm === 'string' || queryTerm instanceof String)
		{
			return {
				value: this.postprocessQueryTerm(inQueryTerm, queryTerm, item),
				min: "?_prop pqv:P1319 ?_min_value.",
				max: "?_prop pqv:P1326 ?_max_value."
			}
		}
		else
		{
			const result = {}
			for (const key in queryTerm)
			{
				result[key] = this.postprocessQueryTerm(inQueryTerm, queryTerm[key], item)
			}
			return result
		}
	},

	extractQidFromUrl: function(url)
	{
		const lastSlashIndex = url.lastIndexOf("/")
		if (lastSlashIndex >= 0)
			return url.substring(lastSlashIndex + 1)
		else
			return url
	},

	// Sequential list of filters to narrow down a list of bindings to the best result
	bindingFilters: [
		(binding, index, array) => {
			return binding._rank.value != wikidata.rankDeprecated;
		},
		(binding, index, array) => {
			return binding._rank.value === wikidata.rankPreferred;
		},
	],

	// From the specified set of bindings, returns only the best ones to use
	filterBestBindings: function(inBindings)
	{
		// filter the values down until there are none
		var lastBindings = inBindings.slice()
		for (const filter of this.bindingFilters)
		{
			workingBindings = lastBindings.filter(filter)
			if (workingBindings.length == 0)
			{
				break
			}
			lastBindings = workingBindings
		}
		return lastBindings
	},

	// runs a SPARQL query for time values on an item or set of items
	runTimeQueryTerm: async function (queryTermStr, items)
	{
		// keys that may appear on the query term that provide terms
		const termTimeKeys = [
			"general",
			"start", "start_min", "start_max",
			"end", "end_min", "end_max",
			"value", "min", "max"
		]
		const termOtherKeys = [ "previous", "next" ]

		const entityVarName = '_entity'
		const entityVar = `?${entityVarName}`
		const propVar = '?_prop'
		const rankVar = '?_rank'

		// create a dummy item representing the collective items
		//TODO: validate that they match
		item = { ...items[0] }
		item.entity = entityVar
		item.id = "DUMMY"

		const queryBuilder = new SparqlBuilder()
		queryBuilder.addCacheBuster(item.cacheBuster ? item.cacheBuster : this.cacheBuster)

		queryTerm = this.getValueQueryTerm(queryTermStr, item)
		
		// assembly query targets
		const targetEntities = new Set()
		for (const item of items)
		{
			targetEntities.add(`wd:${item.entity}`)
		}
		queryBuilder.addQueryTerm(`VALUES ${entityVar}{${[...targetEntities].join(' ')}}`)
		queryBuilder.addOutParam(entityVar, { groupBy: true })

		// Group by prop object so that multiple prev/next values on the same property are grouped,
		// but different properties with different prev/next values are separate.
		queryBuilder.addGroupParam(propVar)

		queryBuilder.addOutParam(rankVar, { groupBy: true })
		if (queryTerm.general)
		{
			queryBuilder.addQueryTerm(queryTerm.general)
		}
		if (queryTerm.value) //TODO: could unify better with loop below?
		{
			queryBuilder.addQueryTerm(queryTerm.value)
			queryBuilder.addTimeBreak("?_value", "?_value_ti", "?_value_pr", { groupBy: true })
		}
		for (const termKey of termTimeKeys)
		{
			if (!queryTerm[termKey]) continue
			if (termKey == "general" || termKey == "value") continue
			queryBuilder.addOptionalTimeTerm(queryTerm[termKey], `?_${termKey}_value`, `?_${termKey}_ti`, `?_${termKey}_pr`, { groupBy: true })
		}
		for (const termKey of termOtherKeys)
		{
			if (!queryTerm[termKey]) continue
			queryBuilder.addOutParam(`(GROUP_CONCAT(DISTINCT ?_${termKey}_value; SEPARATOR=";") AS ?_${termKey}_out)`)
			queryBuilder.addOptionalQueryTerm(queryTerm[termKey])
		}
		queryBuilder.addOptionalQueryTerm(`${propVar} wikibase:rank ${rankVar}.`)

		const query = queryBuilder.build()

		// read cache
		const cacheKey = query
		if (!this.skipCache && !item.skipCache && this.cache[cacheKey])
		{
			return this.cache[cacheKey]
		}
		
		const data = await this.runQuery(query)
		console.log(`\tQuery for ${item.id} returned ${data.results.bindings.length} results.`)

		const readBinding = function(binding)
		{
			const result = {}
			for (const termKey of termTimeKeys)
			{
				if (binding[`_${termKey}_ti`])
				{
					result[termKey] = {
						value: binding[`_${termKey}_ti`].value,
						precision: parseInt(binding[`_${termKey}_pr`].value)
					}
				}
			}
			for (const termKey of termOtherKeys)
			{
				const termOtherVar = `_${termKey}_out`
				if (binding[termOtherVar])
				{
					const valueSplit = binding[termOtherVar].value.split(';')
					result[termKey] = wikidata.extractQidFromUrl(valueSplit[0]) //HACK: does not support multiple values
				}
			}
			return result
		}

		const readBindings = function(bindings)
		{
			const results = []
			for (const binding of bindings)
			{
				const newBinding = readBinding(binding)
				const newBindingSerialized = JSON.stringify(newBinding) //HACK: serialization for comparison

				//HACK: omit perfect duplicates. This can happen with overlapping statements for same position (e.g. Q8423 "position held" for subclass:king)
				var isDupe = false
				for (const result of results)
				{
					isDupe = (JSON.stringify(result) == newBindingSerialized)
					if (isDupe) break
				}
				
				if (!isDupe) results.push(readBinding(binding))
			}
			return results
		}

		// arrays of bindings, grouped by entity id
		const bindingsByEntity = {}

		// sort out the bindings by entity
		for (const binding of data.results.bindings)
		{
			// read entity id
			assert(binding[entityVarName].type == 'uri')
			const entityId = this.extractQidFromUrl(binding[entityVarName].value)

			// get array for entity-specific results
			var entityBindings = bindingsByEntity[entityId]
			if (!entityBindings)
			{
				entityBindings = []
				bindingsByEntity[entityId] = entityBindings
			}

			entityBindings.push(binding)
		}

		// filter results down to best per entity
		const result = {}
		for (const entityId in bindingsByEntity)
		{
			const entityBindings = bindingsByEntity[entityId]
			if (entityBindings.length == 1)
			{
				result[entityId] = readBinding(entityBindings[0])
			}
			else // entityBindings.length > 1
			{
				var lastBindings = this.filterBestBindings(entityBindings)
				result[entityId] = readBindings(lastBindings)
			}
		}

		this.cache[cacheKey] = result;
		return result;
	},

	/**
	 * Runs an unsorted list of path queries.
	 */
	runPathQueries: async function(queries)
	{
		const wdStandaloneIds = new Set()
		const wdProperties = new Set()
		const wdQualifiers = new Set()
		for (const query of queries)
		{
			const match = query.match(/^(Q[0-9]+(?::P[0-9]+)?(?::Q[0-9]+:P[0-9]+)?)([\+>](?:[A-Za-z]+(?:![0-9]+)?|P\-?[0-9A-Z]+)+)*$/)
			if (match && match[1])
			{
				const root = match[1]
				const split = root.split(':')
				if (split.length == 1)
				{
					wdStandaloneIds.add(root)
				}
				else if (split.length == 2)
				{
					wdProperties.add(root)
				}
				else if (split.length == 4)
				{
					wdQualifiers.add(root)
				}
				else
				{
					console.error(`Error: Unrecognized path date format: '${query}'`)
				}
			}
			else
			{
				console.error(`Error: Unrecognized path date format: '${query}'`)
			}
		}

		await this.runObjectPathQueries(wdStandaloneIds)
		await this.runPropertyPathQueries(wdProperties)
		await this.runQualifierPathQueries(wdQualifiers)
	},

	// runs a list of plain item path queries (e.g. "Q302") and stores the values in the path cache
	runObjectPathQueries: async function(queries)
	{
		//TODO: might need smarter date interpretation, multiple value handling, etc
		const idsToQuery = []
		for (const wdId of queries)
		{
			if (!this.pathCache[wdId]) idsToQuery.push(wdId)
		}
		if (idsToQuery.length > 0)
		{
			const queryBuilder = new SparqlBuilder()
			queryBuilder.addOutParam('?item')
			queryBuilder.addQueryTerm(`VALUES ?item{${idsToQuery.map(id => `wd:${id}`).join(' ')}}`)
			queryBuilder.addQueryTerm(`?item (p:P585/psv:P585)|(p:P580/psv:P580)|(p:P569/psv:P569)|(p:P571/psv:P571) ?value.`)
			queryBuilder.addTimeBreak('?value', '?date', '?precision')
			const query = queryBuilder.build()
			console.log(query)
			const data = await this.runQuery(query)
			const foundKeys = new Set()
			for (const binding of data.results.bindings)
			{
				const key = this.extractQidFromUrl(binding['item'].value)
				this.pathCache[key] = { value: binding['date'].value, precision: binding['precision'].value }
				foundKeys.add(key)
			}

			// mark items with no result as missing
			for (const wdId of idsToQuery)
			{
				if (!foundKeys.has(wdId)) this.pathCache[wdId] = { value: null }
			}
		}
	},

	// runs a list of item-property path queries (e.g. "Q302:P570") and stores the values in the path cache
	runPropertyPathQueries: async function(queries)
	{
		//TODO: might need smarter date interpretation, multiple value handling, etc
		const propsToQuery = []
		for (const wdProp of queries)
		{
			if (!this.pathCache[wdProp]) propsToQuery.push(wdProp)
		}
		if (propsToQuery.length > 0)
		{
			const propMap = function(str) {
				const split = str.split(':')
				return `(wd:${split[0]} p:${split[1]} psv:${split[1]})`
			}
			const queryBuilder = new SparqlBuilder()
			queryBuilder.addOutParam('?item')
			queryBuilder.addOutParam('?p')
			queryBuilder.addQueryTerm(`VALUES (?item ?p ?psv){${propsToQuery.map(propMap).join('')}}`)
			queryBuilder.addQueryTerm('?item ?p ?statement.')
			queryBuilder.addQueryTerm('?statement ?psv ?value.')
			queryBuilder.addTimeBreak('?value', '?date', '?precision')
			const query = queryBuilder.build()
			console.log(query)
			const data = await this.runQuery(query)
			const foundKeys = new Set()
			for (const binding of data.results.bindings)
			{
				const qid = this.extractQidFromUrl(binding['item'].value)
				const pid = this.extractQidFromUrl(binding['p'].value)
				const key = `${qid}:${pid}`
				this.pathCache[key] = { value: binding['date'].value, precision: binding['precision'].value }
				foundKeys.add(key)
			}

			// mark items with no result as missing
			for (const wdProp of propsToQuery)
			{
				if (!foundKeys.has(wdProp)) this.pathCache[wdProp] = { value: null }
			}
		}
	},

	// runs a list of item-property-qualifier path queries (e.g. "Q129165:P39:Q938153:P580") and stores the values in the path cache
	runQualifierPathQueries: async function(queries)
	{
		//TODO: might need smarter date interpretation, multiple value handling, etc
		const qualsToQuery = []
		for (const wdProp of queries)
		{
			if (!this.pathCache[wdProp]) qualsToQuery.push(wdProp)
		}
		if (qualsToQuery.length > 0)
		{
			const qualMap = function(str) {
				const split = str.split(':')
				return `(wd:${split[0]} p:${split[1]} ps:${split[1]} wd:${split[2]} pqv:${split[3]})`
			}
			const queryBuilder = new SparqlBuilder()
			queryBuilder.addOutParam('?item')
			queryBuilder.addOutParam('?p')
			queryBuilder.addOutParam('?value')
			queryBuilder.addOutParam('?q')
			queryBuilder.addQueryTerm(`VALUES (?item ?p ?psv ?value ?q){${qualsToQuery.map(qualMap).join('')}}`)
			queryBuilder.addQueryTerm('?item ?p [ ?psv ?value; ?q ?datev ].')
			queryBuilder.addTimeBreak('?datev', '?date', '?precision')
			const query = queryBuilder.build()
			console.log(query)
			const data = await this.runQuery(query)
			const foundKeys = new Set()
			for (const binding of data.results.bindings)
			{
				const itemId = this.extractQidFromUrl(binding['item'].value)
				const propId = this.extractQidFromUrl(binding['p'].value)
				const valId = this.extractQidFromUrl(binding['value'].value)
				const qualId = this.extractQidFromUrl(binding['q'].value)
				const key = `${itemId}:${propId}:${valId}:${qualId}`
				this.pathCache[key] = { value: binding['date'].value, precision: binding['precision'].value }
				foundKeys.add(key)
			}

			// mark items with no result as missing
			for (const wdProp of qualsToQuery)
			{
				if (!foundKeys.has(wdProp)) this.pathCache[wdProp] = { value: null }
			}
		}
	},

	// runs a SPARQL query that generates multiple items
	createTemplateItems: async function(templateItem)
	{
		//TODO: caching

		const itemVarName = "_node"
		const itemVar = `?${itemVarName}`
		templateItem.entity = itemVar

		var itemQueryTerm
		if (templateItem.itemQuery)
		{
			if (templateItem.items)
			{
				console.warn(`Template item '${templateItem.comment}' has both 'itemQuery' and 'items': 'items' will be ignored.`)
			}
			itemQueryTerm = this.getItemQueryTerm(templateItem.itemQuery, templateItem)
		}
		else if (templateItem.items)
		{
			itemQueryTerm = `VALUES ${itemVar}{${templateItem.items.map(id => `wd:${id}` ).join(' ')}}`
		}
		else
		{
			console.error(`Template item '${templateItem.comment}' has no 'itemQuery' or 'items'.`)
			return []
		}

		const queryBuilder = new SparqlBuilder()
		queryBuilder.distinct = true
		queryBuilder.addCacheBuster(this.cacheBuster)
		queryBuilder.addOutParam(itemVar)
		queryBuilder.addOutParam(itemVar + "Label")
		queryBuilder.addQueryTerm(itemQueryTerm)
		queryBuilder.addWikibaseLabel(this.lang)
		
		const query = queryBuilder.build()
		const data = await this.runQuery(query)

		const newItems = []

		// clone the template for each result
		for (const binding of data.results.bindings)
		{
			const newItem = structuredClone(templateItem)
			delete newItem.comment
			delete newItem.itemQuery
			delete newItem.items
			newItem.entity = this.extractQidFromUrl(binding[itemVarName].value)
			newItem.generated = true
			const wikidataLabel = binding[itemVarName + "Label"].value

			const labelFomat = templateItem.label ? templateItem.label : this.inputSpec.chronicle.defaultLabel
			newItem.label = labelFomat.replaceAll("{_LABEL}", wikidataLabel).replaceAll("{_QID}", newItem.entity)
				
			newItems.push(newItem)
		}

		templateItem.finished = true
		console.log(`Item template '${templateItem.comment}' created ${newItems.length} items.`)

		return newItems;
	},

	// runs a SPARQL query
	runQuery: async function(query)
	{
		if (this.verboseLogging) console.log(query)

		assert(this.options)
		const options = { ...this.options, body: query }
		const response = await fetch(this.sparqlUrl, options)
		if (response.status != 200)
		{
			console.log(response)
			console.error(`${response.status}: ${response.statusText}`)
			return null
		}
		else
		{
			const data = await response.json()
			return data
		}
	}
} 
