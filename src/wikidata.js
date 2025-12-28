
const mypath = require("./mypath.js")
const fs = require('fs');
const globalData = require("./global-data.json")
const assert = require('node:assert/strict')
const SparqlBuilder = require("./sparql-builder.js")

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
		const entityVarName = '_entity'
		const entityVar = `?${entityVarName}`
		const propVar = '?_prop'
		const rankVar = '?_rank'

		const queryBuilder = new SparqlBuilder()

		// create a dummy item representing the collective items
		//TODO: validate that they match
		item = { ...items[0] }
		item.entity = entityVar
		item.id = "DUMMY"

		queryTerm = this.getValueQueryTerm(queryTermStr, item)
		
		// assembly query targets
		const targetEntities = new Set()
		for (const item of items)
		{
			targetEntities.add(`wd:${item.entity}`)
		}
		queryBuilder.addQueryTerm(`VALUES ${entityVar}{${[...targetEntities].join(' ')}}`)
		queryBuilder.addOutParam(entityVar)

		queryBuilder.addOutParam(rankVar)
		if (queryTerm.general)
		{
			queryBuilder.addQueryTerm(queryTerm.general)
		}
		if (queryTerm.value) //TODO: could unify better with loop below?
		{
			queryBuilder.addTimeTerm(queryTerm.value, "?_value", "?_value_ti", "?_value_pr")
		}
		for (const termKey in queryTerm) //TODO: only pass recognized terms
		{
			if (termKey == "general" || termKey == "value") continue
			queryBuilder.addOptionalTimeTerm(queryTerm[termKey], `?_${termKey}_value`, `?_${termKey}_ti`, `?_${termKey}_pr`)
		}
		queryBuilder.addOptionalQueryTerm(`${propVar} wikibase:rank ${rankVar}.`)

		const query = queryBuilder.build()

		// read cache
		const cacheKey = query
		if (!this.skipCache && this.cache[cacheKey])
		{
			return this.cache[cacheKey]
		}
		
		const data = await this.runQuery(query)
		console.log(`\tQuery for ${item.id} returned ${data.results.bindings.length} results.`)

		const readBinding = function(binding)
		{
			const result = {}
			for (const termKey in queryTerm) //TODO: only use recognized terms
			{
				if (binding[`_${termKey}_ti`])
				{
					result[termKey] = {
						value: binding[`_${termKey}_ti`].value,
						precision: parseInt(binding[`_${termKey}_pr`].value)
					}
				}
			}
			return result
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

		// filter down to one result per entity
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
				if (lastBindings.length > 1)
				{
					console.warn("\tQuery returned multiple equally-preferred values.")
				}
				result[entityId] = readBinding(lastBindings[0])
			}
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

		const queryBuilder = new SparqlBuilder()
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
