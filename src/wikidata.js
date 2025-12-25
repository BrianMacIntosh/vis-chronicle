
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

	// Sequential list of filters to narrow down a list of bindings to the best result
	bindingFilters: [
		(binding, index, array) => {
			return binding.rank.value != wikidata.rankDeprecated;
		},
		(binding, index, array) => {
			return binding.rank.value === wikidata.rankPreferred;
		},
	],

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
		const contents = await fs.promises.readFile(this.termCacheFile)
		this.cache = JSON.parse(contents)
	},

	writeCache: async function()
	{
		await mypath.ensureDirectoryForFile(this.termCacheFile)

		// write the wikidata cache
		fs.writeFile(this.termCacheFile, JSON.stringify(this.cache), err => {
			if (err) {
				console.error(`Error writing wikidata cache:`)
				console.error(err)
			}
		})
	},

	// dereferences the query term if it's a pointer to a template
	getQueryTerm: function(queryTerm, item)
	{
		if (queryTerm.startsWith("#"))
		{
			const templateName = queryTerm.substring(1).trim()

			var queryTemplate;
			if (this.inputSpec.queryTemplates && this.inputSpec.queryTemplates[templateName])
			{
				queryTemplate = this.inputSpec.queryTemplates[templateName]
			}
			else (globalData && globalData.queryTemplates && globalData.queryTemplates[templateName])
			{
				queryTemplate = globalData.queryTemplates[templateName]
			}

			if (queryTemplate)
			{
				queryTerm = queryTemplate

				// replace query wildcards
				for (const key in item)
				{
					var insertValue = item[key]
					if (typeof insertValue === "string" && insertValue.startsWith("Q"))
						insertValue = "wd:" + insertValue
					queryTerm = queryTerm.replace(`{${key}}`, insertValue)
				}
			}
			else
			{
				throw `Query template '${templateName}' not found (on item ${item.id}).`
			}
		}
		
		//TODO: detect unreplaced wildcards

		if (!queryTerm.trim().endsWith("."))
		{
			queryTerm += "."
		}
		return queryTerm
	},

	extractQidFromUrl: function(url)
	{
		const lastSlashIndex = url.lastIndexOf("/")
		if (lastSlashIndex >= 0)
			return url.substring(lastSlashIndex + 1)
		else
			return url
	},

	// runs a SPARQL query term for a time value (after wrapping it in the appropriate boilerplate)
	runTimeQueryTerm: async function (queryTerm, item)
	{
		queryTerm = this.getQueryTerm(queryTerm, item)

		// read cache
		if (!this.skipCache && this.cache[queryTerm])
		{
			console.log("\tTerm cache hit.")
			return this.cache[queryTerm]
		}
		
		const propVar = '?_prop'
		const valueVar = '?_value'

		var outParams = [ '?time', '?precision', '?rank' ]
		var queryTerms = [
			queryTerm,
			`OPTIONAL { ${propVar} wikibase:rank ?rank. }`,
			`${valueVar} wikibase:timeValue ?time.`,
			`${valueVar} wikibase:timePrecision ?precision.`
		]

		//TODO: prevent injection
		const query = `SELECT ${outParams.join(" ")} WHERE {${queryTerms.join(" ")}}`

		const data = await this.runQuery(query)
		console.log(`\tQuery for ${item.id} returned ${data.results.bindings.length} results.`)

		var result;
		if (data.results.bindings.length <= 0)
		{
			result = {}
		}
		else if (data.results.bindings.length == 1)
		{
			result = {
				value: data.results.bindings[0].time.value,
				precision: parseInt(data.results.bindings[0].precision.value)
			}
		}
		else // data.results.bindings.length > 1
		{
			// filter the values down until there are none
			var lastBindings = data.results.bindings.slice()
			for (const filter of this.bindingFilters)
			{
				workingBindings = lastBindings.filter(filter)
				if (workingBindings.length == 0)
				{
					break
				}
				lastBindings = workingBindings
			}
			
			if (lastBindings.length > 1)
			{
				console.warn("\tQuery returned multiple equally-preferred values.")
			}

			result = {
				value: lastBindings[0].time.value,
				precision: parseInt(lastBindings[0].precision.value)
			}
		}

		this.cache[queryTerm] = result;
		return result;
	},

	// runs a SPARQL query that generates multiple items
	createTemplateItems: async function(templateItem)
	{
		//TODO: caching

		const itemVarName = "_node"
		const itemVar = `?${itemVarName}`
		templateItem.entity = itemVar
		const itemQueryTerm = this.getQueryTerm(templateItem.itemQuery, templateItem)

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
				? templateItem.label.replace("{_LABEL}", wikidataLabel)
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
