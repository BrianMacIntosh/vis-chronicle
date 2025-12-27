
const mypath = require("./mypath.js")
const fs = require('fs');
const globalData = require("./global-data.json")
const assert = require('node:assert/strict');

const wikidata = module.exports = {

	inputSpec: null,
	verboseLogging: false,

	cache: {}, // caches single-time queries
	cache2: {}, // caches hybrid start/end time queries
	skipCache: false,
	termCacheFile: "intermediate/wikidata-term-cache.json",
	termCache2File: "intermediate/wikidata-term-cache2.json",

	sparqlUrl: "https://query.wikidata.org/sparql",
	lang: "en,mul",

	rankDeprecated: "http://wikiba.se/ontology#DeprecatedRank",
	rankNormal: "http://wikiba.se/ontology#NormalRank",
	rankPreferred: "http://wikiba.se/ontology#PreferredRank",

	initialize: function()
	{
		const chroniclePackage = require("../package.json")
		this.options = {
			headers: {
				'User-Agent': `vis-chronicle/${chroniclePackage.version} (https://github.com/BrianMacIntosh/vis-chronicle) Node.js/${process.version}`
			}
		}
	},

	setLang: function(inLang)
	{
		//TODO: escape
		this.lang = inLang
	},

	setInputSpec: function(inSpec)
	{
		this.inputSpec = inSpec
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
			const contents2 = await fs.promises.readFile(this.termCache2File)
			this.cache2 = JSON.parse(contents2)
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
				console.error(`Error writing wikidata cache:`)
				console.error(err)
			}
		})

		await mypath.ensureDirectoryForFile(this.termCache2File)

		fs.writeFile(this.termCache2File, JSON.stringify(this.cache2), err => {
			if (err) {
				console.error(`Error writing wikidata cache 2:`)
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

	postprocessQueryTerm: function(term, item)
	{
		// replace query wildcards
		for (const key in item)
		{
			var insertValue = item[key]
			if (typeof insertValue === "string" && insertValue.startsWith("Q"))
				insertValue = "wd:" + insertValue
			term = term.replaceAll(`{${key}}`, insertValue)
		}
		//TODO: detect unreplaced wildcards

		// terminate term
		if (!term.trim().endsWith("."))
		{
			term += "."
		}

		return term
	},

	// Dereferences the query term if it's a pointer to a template.
	// Expects simple string terms (start or end)
	getQueryTermHelper: function(queryTerm, item, tempateSetName)
	{
		if (queryTerm.startsWith("#"))
		{
			const templateName = queryTerm.substring(1).trim()
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

		//TODO: validate query has required wildcards
		
		queryTerm = this.postprocessQueryTerm(queryTerm, item)
		return queryTerm
	},

	// Dereferences the query term if it's a pointer to a template.
	// Expects simple string terms (start or end)
	getValueQueryTerm: function(queryTerm, item)
	{
		return this.getQueryTermHelper(queryTerm, item, "queryTemplates")
	},

	// Dereferences the query term if it's a pointer to a template.
	// Expects item-generating terms
	getItemQueryTerm: function(queryTerm, item)
	{
		return this.getQueryTermHelper(queryTerm, item, "itemQueryTemplates")
	},

	// Dereferences the query term if it's a pointer to a template.
	// Expects hybrid start/end terms.
	getValueQueryTerm2: function(queryTerm, item)
	{
		if (queryTerm.startsWith("#"))
		{
			const templateName = queryTerm.substring(1).trim()
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
		
		return {
			general: this.postprocessQueryTerm(queryTerm.general, item),
			start: this.postprocessQueryTerm(queryTerm.start, item),
			end: this.postprocessQueryTerm(queryTerm.end, item)
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

	createQuery: function(outParams, queryTerms)
	{
		//TODO: prevent injection
		return `SELECT ${outParams.join(" ")} WHERE{${queryTerms.join(" ")}}`
	},

	// Sequential list of filters to narrow down a list of bindings to the best result
	bindingFilters: [
		(binding, index, array) => {
			return binding.rank.value != wikidata.rankDeprecated;
		},
		(binding, index, array) => {
			return binding.rank.value === wikidata.rankPreferred;
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

	// runs a SPARQL query term for a time value (after wrapping it in the appropriate boilerplate)
	runTimeQueryTerm: async function (queryTermStr, item)
	{
		const readTimeFromBindings = function(bindings, index)
		{
			return {
				value: bindings[index][timeVarName].value,
				precision: parseInt(bindings[index][precisionVarName].value)
			}
		}

		queryTerm = this.getValueQueryTerm(queryTermStr, item)

		// read cache
		const cacheKey = queryTerm //TODO: should probably be the full query so it invalidates for code changes
		if (!this.skipCache && !item.skipCache && this.cache[cacheKey])
		{
			console.log("\tTerm cache hit.")
			return this.cache[cacheKey]
		}
		
		const propVar = '?_prop'
		const valueVar = '?_value'
		const rankVar = '?rank'
		const timeVarName = 'time'
		const timeVar = `?${timeVarName}`
		const precisionVarName = 'precision'
		const precisionVar = `?${precisionVarName}`

		var outParams = [ timeVar, precisionVar, rankVar ]
		var queryTerms = [ queryTerm,
			`OPTIONAL { ${propVar} wikibase:rank ${rankVar}. }`,
			`${valueVar} wikibase:timeValue ${timeVar}.`,
			`${valueVar} wikibase:timePrecision ${precisionVar}.`
		]

		const query = this.createQuery(outParams, queryTerms)

		const data = await this.runQuery(query)
		console.log(`\tQuery for ${item.id} returned ${data.results.bindings.length} results.`)

		var result;
		if (data.results.bindings.length <= 0)
		{
			result = {}
		}
		else if (data.results.bindings.length == 1)
		{
			result = readTimeFromBindings(data.results.bindings, 0)
		}
		else // data.results.bindings.length > 1
		{
			var lastBindings = this.filterBestBindings(data.results.bindings)
			if (lastBindings.length > 1)
			{
				console.warn("\tQuery returned multiple equally-preferred values.")
			}
			result = readTimeFromBindings(lastBindings, 0)
		}

		this.cache[cacheKey] = result;
		return result;
	},

	// runs a SPARQL query term for start and end time values (after wrapping it in the appropriate boilerplate)
	runTimeQueryTerm2: async function (queryTermStr, item)
	{
		const readStartEndFromBindings = function(bindings, index)
		{
			const result = {}
			if (bindings[index][timeStartVarName])
			{
				result.start = {
					value: bindings[index][timeStartVarName].value,
					precision: parseInt(bindings[index][precisionStartVarName].value)
				}
			}
			if (bindings[index][timeEndVarName])
			{
				result.end = {
					value: bindings[index][timeEndVarName].value,
					precision: parseInt(bindings[index][precisionEndVarName].value)
				}
			}
			return result
		}

		queryTerm = this.getValueQueryTerm2(queryTermStr, item)
		if (!queryTerm.general || !queryTerm.start || !queryTerm.end)
		{
			console.warn(`\tQuery term '${queryTermStr}' is not a start/end query.`)
			return null
		}

		const propVar = '?_prop'
		const valueStartVar = '?_value_s'
		const valueEndVar = '?_value_e'
		const rankVar = '?rank'
		const timeStartVarName = 'time_s'
		const timeStartVar = `?${timeStartVarName}`
		const precisionStartVarName = 'precision_s'
		const precisionStartVar = `?${precisionStartVarName}`
		const timeEndVarName = 'time_e'
		const timeEndVar = `?${timeEndVarName}`
		const precisionEndVarName = 'precision_e'
		const precisionEndVar = `?${precisionEndVarName}`

		var outParams = [ timeStartVar, precisionStartVar, timeEndVar, precisionEndVar, rankVar ]
		var queryTerms = [ queryTerm.general,
			`OPTIONAL { ${propVar} wikibase:rank ${rankVar}. }`,
			`OPTIONAL { ${queryTerm.start} ${valueStartVar} wikibase:timeValue ${timeStartVar}. ${valueStartVar} wikibase:timePrecision ${precisionStartVar}. }`,
			`OPTIONAL { ${queryTerm.end} ${valueEndVar} wikibase:timeValue ${timeEndVar}. ${valueEndVar} wikibase:timePrecision ${precisionEndVar}. }`,
		]

		const query = this.createQuery(outParams, queryTerms)

		// read cache
		const cacheKey = query
		if (!this.skipCache && !item.skipCache &&this.cache2[cacheKey])
		{
			console.log("\tTerm cache 2 hit.")
			return this.cache2[cacheKey]
		}
		
		const data = await this.runQuery(query)
		console.log(`\tQuery for ${item.id} returned ${data.results.bindings.length} results.`)

		var result;
		if (data.results.bindings.length <= 0)
		{
			result = {}
		}
		else if (data.results.bindings.length == 1)
		{
			result = readStartEndFromBindings(data.results.bindings, 0)
		}
		else // data.results.bindings.length > 1
		{
			var lastBindings = this.filterBestBindings(data.results.bindings)
			if (lastBindings.length > 1)
			{
				console.warn("\tQuery returned multiple equally-preferred values.")
			}
			result = readStartEndFromBindings(lastBindings, 0)
		}

		this.cache2[cacheKey] = result;
		return result;
	},

	// runs a SPARQL query that generates multiple items
	createTemplateItems: async function(templateItem)
	{
		//TODO: caching

		const itemVarName = "_node"
		const itemVar = `?${itemVarName}`
		templateItem.entity = itemVar
		const itemQueryTerm = this.getItemQueryTerm(templateItem.itemQuery, templateItem)

		var outParams = [ itemVar, itemVar + "Label" ]
		var queryTerms = [ itemQueryTerm, `SERVICE wikibase:label { bd:serviceParam wikibase:language "${this.lang}". }` ]
		
		//TODO: prevent injection
		const query = `SELECT ${outParams.join(" ")} WHERE {${queryTerms.join(" ")}}`
		const data = await this.runQuery(query)

		const newItems = []

		// clone the template for each result
		for (const binding of data.results.bindings)
		{
			const newItem = structuredClone(templateItem)
			delete newItem.comment
			delete newItem.itemQuery
			newItem.entity = this.extractQidFromUrl(binding[itemVarName].value)
			const wikidataLabel = binding[itemVarName + "Label"].value
			newItem.label = templateItem.label !== undefined
				? templateItem.label.replaceAll("{_LABEL}", wikidataLabel)
				: wikidataLabel;
			newItems.push(newItem)
		}

		templateItem.finished = true
		console.log(`Item-generating query '${templateItem.itemQuery}' created ${newItems.length} items.`)

		return newItems;
	},

	// runs a SPARQL query
	runQuery: async function(query)
	{
		if (this.verboseLogging) console.log(query)

		const params = "format=json&query=" + encodeURIComponent(query)
		const request = this.sparqlUrl + "?" + params
		//if (this.verboseLogging) console.log(request)

		assert(this.options)
		const response = await fetch(request, this.options)
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
