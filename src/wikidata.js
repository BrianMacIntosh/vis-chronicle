
const mypath = require("./mypath.js")
const fs = require('fs');
const globalTemplates = require("./global-templates.json")

module.exports = {

	inputSpec: null,
	verboseLogging: false,

	cache: {},
	skipCache: false,
	termCacheFile: "intermediate/wikidata-term-cache.json",

	sparqlUrl: "https://query.wikidata.org/sparql",

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
	getQueryTerm: function(queryTerm, outVarName, item)
	{
		if (queryTerm.startsWith("#"))
		{
			const templateName = queryTerm.substring(1).trim()

			var queryTemplate;
			if (this.inputSpec.queryTemplates && this.inputSpec.queryTemplates[templateName])
			{
				queryTemplate = this.inputSpec.queryTemplates[templateName]
			}
			else (globalTemplates && globalTemplates[templateName])
			{
				queryTemplate = globalTemplates[templateName]
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

				//TODO: detect unreplaced wildcards
			}
			else
			{
				throw `Query template '${templateName}' not found (on item ${item.id}).`
			}
		}
		queryTerm = queryTerm.replaceAll("{_OUTVAR}", outVarName)
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
		queryTerm = this.getQueryTerm(queryTerm, "?time", item)

		// read cache
		if (!this.skipCache && this.cache[queryTerm])
		{
			console.log("Term cache hit.")
			return this.cache[queryTerm]
		}
		
		var outParams = [ '?value', '?precision' ]
		var queryTerms = [ queryTerm, '?time wikibase:timeValue ?value.', '?time wikibase:timePrecision ?precision.' ]

		//TODO: prevent injection
		const query = `SELECT ${outParams.join(" ")} WHERE {${queryTerms.join(" ")}}`

		const data = await this.runQuery(query)
		if (data.results.bindings.length == 0)
		{
			console.warn(`Query for ${item.id} returned no bindings.`)
			this.cache[queryTerm] = {}
			return {}
		}
		else
		{
			if (data.results.bindings.length > 1)
			{
				console.warn(`Query for ${item.id} returned multiple bindings. Using the first.`)
			}
			console.log(`Query for ${item.id} succeeded.`)
			const result = {
				value: data.results.bindings[0].value.value,
				precision: parseInt(data.results.bindings[0].precision.value)
			}
			this.cache[queryTerm] = result;
			return result;
		}
	},

	// runs a SPARQL query that generates multiple items
	createTemplateItems: async function(templateItem)
	{
		//TODO: caching

		const itemVarName = "itemVar"
		const itemVar = `?${itemVarName}`
		templateItem.entity = itemVar
		const itemQueryTerm = this.getQueryTerm(templateItem.itemQuery, itemVar, templateItem)

		var outParams = [ itemVar, itemVar + "Label" ]
		var queryTerms = [ itemQueryTerm, `SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }` ]
		
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
			newItem.label = binding[itemVarName + "Label"].value
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
		const response = await fetch(this.sparqlUrl + "?" + params) // SPARQL does not accept POST
		if (response.status != 200)
		{
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
