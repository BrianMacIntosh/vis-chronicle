
const mypath = require("./mypath.js")
const fs = require('fs');
const globalData = require("./global-data.json")
const assert = require('node:assert/strict');

const wikidata = module.exports = {

	inputSpec: null,
	verboseLogging: false,

	cache: {},
	skipCache: false,
	termCacheFile: "intermediate/wikidata-term-cache.json",

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
	// Expects item-generating terms
	getItemQueryTerm: function(queryTerm, item)
	{
		return this.getQueryTermHelper(queryTerm, item, "itemQueryTemplates")
	},

	// Dereferences the query term if it's a pointer to a template.
	getValueQueryTerm: function(queryTerm, item)
	{
		if (queryTerm.startsWith && queryTerm.startsWith("#"))
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

		if (typeof queryTerm === 'string' || queryTerm instanceof String)
		{
			return {
				value: this.postprocessQueryTerm(queryTerm, item),
				min: "?_prop pqv:P1319 ?_min_value.",
				max: "?_prop pqv:P1326 ?_max_value."
			}
		}
		else
		{
			const result = {}
			for (const key in queryTerm)
			{
				result[key] = this.postprocessQueryTerm(queryTerm[key], item)
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

	// runs a SPARQL query term for time values (after wrapping it in the appropriate boilerplate)
	runTimeQueryTerm: async function (queryTermStr, item)
	{
		queryTerm = this.getValueQueryTerm(queryTermStr, item)

		generateOptionalTimeTerm = function(term, valueVar, timeVar, precisionVar)
		{
			if (term)
			{
				outParams.push(timeVar)
				outParams.push(precisionVar)
				queryTerms.push(`OPTIONAL { ${term} ${valueVar} wikibase:timeValue ${timeVar}. ${valueVar} wikibase:timePrecision ${precisionVar}. }`)
			}
		}

		const propVar = '?_prop'
		const rankVar = '?rank'
		
		var outParams = [ rankVar ]
		var queryTerms = [ ]
		if (queryTerm.general)
		{
			queryTerms.push(queryTerm.general)
		}
		if (queryTerm.value) //TODO: could unify better with loop below?
		{
			outParams.push("?_value_ti")
			outParams.push("?_value_pr")
			queryTerms.push(`${queryTerm.value} ?_value wikibase:timeValue ?_value_ti. ?_value wikibase:timePrecision ?_value_pr.`)
		}
		for (const termKey in queryTerm) //TODO: only pass recognized terms
		{
			if (termKey == "general" || termKey == "value") continue
			generateOptionalTimeTerm(queryTerm[termKey], `?_${termKey}_value`, `?_${termKey}_ti`, `?_${termKey}_pr`)
		}
		queryTerms.push(`OPTIONAL { ${propVar} wikibase:rank ${rankVar}. }`)

		const query = this.createQuery(outParams, queryTerms)

		// read cache
		const cacheKey = query
		if (!this.skipCache && !item.skipCache &&this.cache[cacheKey])
		{
			//console.log("\tTerm cache hit.")
			return this.cache[cacheKey]
		}
		
		const data = await this.runQuery(query)
		console.log(`\tQuery for ${item.id} returned ${data.results.bindings.length} results.`)

		const readBindings = function(bindings, index)
		{
			const result = {}
			for (const termKey in queryTerm) //TODO: only use recognized terms
			{
				if (bindings[index][`_${termKey}_ti`])
				{
					result[termKey] = {
						value: bindings[index][`_${termKey}_ti`].value,
						precision: parseInt(bindings[index][`_${termKey}_pr`].value)
					}
				}
			}
			return result
		}

		var result;
		if (data.results.bindings.length <= 0)
		{
			result = {}
		}
		else if (data.results.bindings.length == 1)
		{
			result = readBindings(data.results.bindings, 0)
		}
		else // data.results.bindings.length > 1
		{
			var lastBindings = this.filterBestBindings(data.results.bindings)
			if (lastBindings.length > 1)
			{
				console.warn("\tQuery returned multiple equally-preferred values.")
			}
			result = readBindings(lastBindings, 0)
		}

		this.cache[cacheKey] = result;
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
			newItem.label = templateItem.label
				? templateItem.label.replaceAll("{_LABEL}", wikidataLabel).replaceAll("{_QID}", newItem.entity)
				: `<a target="_blank" href="https://www.wikidata.org/wiki/${newItem.entity}">${wikidataLabel}</a>`
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
