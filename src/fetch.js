#!/usr/bin/env node

// Uses an input specification file to produce an output file for vis.js Timeline.

const path = require('path')
const nodeutil = require('node:util')
const assert = require('node:assert/strict');

// parse args
const { values, positionals } = nodeutil.parseArgs({
	allowPositionals: true,
	options: {
		"verbose": { type: 'boolean', short: 'v', default: false },
		"skip-wd-cache": { type: 'boolean', default: false },
		"query-url": { type: 'string', short: 'q', default: "https://query.wikidata.org/sparql" },
		"lang": { type: 'string', short: 'l', default: "en,mul" },
		"cachebuster": { type: 'string', default: undefined},
		"out-metadata": { type: 'string', default: undefined}
	}})
	
var specFile = positionals[0]
if (!specFile)
{
	console.error(`No specification file or directory provided.`)
	console.log(`Usage: vis-chronicle IN [OUT]`)
}
else
{
	console.log(`Fetching using spec '${specFile}'.`)
}

var outputFile = positionals[1]
if (!outputFile)
{
	outputFile = "intermediate/timeline.json"
}

var metadataOutputFile = values["out-metadata"]

const moment = require('moment')
const fs = require('fs');
const wikidata = require('./wikidata.js')
const renderer = require('./render.js')
const mypath = require("./mypath.js");
const { flattenRelativeDate } = require('./index.js');
const wikidataToRange2 = require('./wikidataToRange.js')

function wikidataToRange(param)
{
	return wikidataToRange2(param, wikidata.inputSpec.chronicle.maxUncertainTimePrecision)
}

wikidata.skipCache = values["skip-wd-cache"]
wikidata.cacheBuster = values["cachebuster"]
wikidata.sparqlUrl = values["query-url"]
wikidata.verboseLogging = values["verbose"]
wikidata.setLang(values["lang"])
wikidata.initialize()

function rangeUnionAdv(value, min, max)
{
	var aggregate = {}
	if (min)
	{
		assert(min.min)
		aggregate.min = min.min
	}
	else if (value && value.min)
	{
		aggregate.min = value.min
	}
	if (max)
	{
		assert(max.max)
		aggregate.max = max.max
	}
	else if (value && value.max)
	{
		aggregate.max = value.max
	}
	return aggregate
}

function rangeUnion(a, b)
{
	if (!a) return b
	if (!b) return a
	return {
		min: a.min && b.min ? moment.min(a.min, b.min) : a.min || b.min,
		max: a.max && b.max ? moment.max(a.max, b.max) : a.max || b.max
	}
}

async function entryPoint() {}

entryPoint()
.then(async () => {

	await wikidata.readInputSpec(path.join(process.cwd(), specFile));

})
.then(async () => {

	await wikidata.readCache();

})
.then(async () => {

	// replace template items using their item-generating queries
	for (var i = wikidata.inputSpec.items.length - 1; i >= 0; --i)
	{
		var templateItem = wikidata.inputSpec.items[i]
		if (templateItem.itemQuery || templateItem.items)
		{
			//TODO: caching for item queries
			wikidata.inputSpec.items.splice(i, 1)
			const newItems = await wikidata.createTemplateItems(templateItem)
			for (const newItem of newItems)
				wikidata.inputSpec.items.push(newItem)
		}
	}

})
.then(() => {

	var hasError = false;

	// collect all existing ids
	var itemIds = new Set()
	for (const item of wikidata.inputSpec.items)
	{
		if (item.id)
		{
			if (itemIds.has(item.id))
			{
				itemIds.add(item.id)
			}
			else
			{
				console.error(`Item id '${item.id}' appears multiple times.`)
				hasError = true
			}
		}
	}

	// generate ids for items that don't have one
	for (const item of wikidata.inputSpec.items)
	{
		if (!item.id)
		{
			const baseId = item.entity ? item.entity : "anonymous"
			var prospectiveId = baseId
			var i = 0
			while (itemIds.has(prospectiveId))
			{
				i++
				prospectiveId = baseId + "-" + i
			}
			item.id = prospectiveId
			itemIds.add(prospectiveId)
		}
	}

	if (hasError) throw "Error generating item ids."

})
.then(() => {
	
	// batch up queries using templates
	//TODO:

})
.then(async () => {

	// run term-based Wikidata queries

	const isQueryProperty = function(key)
	{
		if (key == "startEndQuery" || key == "startQuery" || key == "endQuery") return true

		//TODO: look at the queries for parameter names
		return key != "comment"
			&& key != "id"
			&& key != "content"
			&& key != "group"
			&& key != "subgroup"
			&& key != "itemQuery"
			&& key != "type"
			&& key != "label"
			&& key != "className"
			&& key != "entity"
			&& key != "skipCache"
			&& key != "startPath" && key != "endPath"
	}

	// bundle items that use the same queries
	const queryBundles = {}
	const pathQueries = []
	for (const item of wikidata.inputSpec.items)
	{
		if (item.finished) continue

		if (item.startPath) pathQueries.push(item.startPath)
		if (item.endPath) pathQueries.push(item.endPath)

		// the bundle key is the queries, as well as any wildcard parameters
		const keyObject = {}
		for (const itemKey in item)
		{
			if (isQueryProperty(itemKey))
			{
				keyObject[itemKey] = item[itemKey]
			}
		}

		const keyStr = JSON.stringify(keyObject)
		var targetBundle = queryBundles[keyStr]
		if (targetBundle)
		{
			targetBundle.push(item)
		}
		else
		{
			targetBundle = [ item ]
			queryBundles[keyStr] = targetBundle
		}
	}

	console.log(`There are ${Object.keys(queryBundles).length} query bundles.`)
	for (const bundleKey in queryBundles)
	{
		const bundle = queryBundles[bundleKey]
		console.log(`\tBundle (${bundle.length} items): ${bundleKey}.`)

		const representativeItem = bundle[0]

		// Populates output items from a query result.
		// Multiple values will be treated as multiple items.
		// Also expects both start and end ranges.
		const copyMultipleResult = function(result, func)
		{
			const aggregateHelper = function(item, entityResult)
			{
				var aggregateStart = rangeUnionAdv(
					wikidataToRange(entityResult.start),
					wikidataToRange(entityResult.start_min),
					wikidataToRange(entityResult.start_max))
				var aggregateEnd = rangeUnionAdv(
					wikidataToRange(entityResult.end),
					wikidataToRange(entityResult.end_min),
					wikidataToRange(entityResult.end_max))

				var aggregateResult = {
					start_min: aggregateStart.min,
					start_max: aggregateStart.max,
					end_min: aggregateEnd.min,
					end_max: aggregateEnd.max,
					previous: entityResult.previous,
					next: entityResult.next
				}
				func(item, aggregateResult)
				item.finished = true
			}

			for (const entityId in result)
			{
				var entityResult = result[entityId]
				if (!(entityResult instanceof Array)) entityResult = [ entityResult ]

				// there may be multiple source items making the same query
				for (const item of bundle)
				{
					if (item.entity == entityId)
					{
						// clone the item for each result beyond the first
						for (var i = 1; i < entityResult.length; ++i)
						{
							const newItem = structuredClone(item)
							newItem.id = `${newItem.id}-v${i}`

							// clones get new subgroups so they are treated as separate objects for stacking
							newItem.subgroup = `${item.subgroup ? item.subgroup : item.entity}-clone${i}`

							wikidata.inputSpec.items.push(newItem) //HACK: modifying original array
							aggregateHelper(newItem, entityResult[i])
						}

						// populate the first result into the original item
						aggregateHelper(item, entityResult[0])
					}
				}
			}
		}

		// Populates output items from a query result.
		// Multiple values will be treated as uncertainty.
		const copySingleResult = function(result, func)
		{
			for (const entityId in result)
			{
				var entityResult = result[entityId]
				if (!(entityResult instanceof Array)) entityResult = [ entityResult ]

				var aggregateResult = {}
				for (var i = 0; i < entityResult.length; ++i)
				{
					var selfAggregate = rangeUnionAdv(
						wikidataToRange(entityResult[i].value),
						wikidataToRange(entityResult[i].min),
						wikidataToRange(entityResult[i].max))
					aggregateResult = rangeUnion(aggregateResult, selfAggregate)
					aggregateResult.previous = aggregateResult.previous ?? entityResult[i].previous //HACK: does not handle multiple values
					aggregateResult.next = aggregateResult.previous ?? entityResult[i].next
				}
				
				// there may be multiple source items making the same query
				for (const item of bundle)
				{
					if (item.entity == entityId)
					{
						func(item, aggregateResult)
						item.finished = true
					}
				}
			}
		}

		if (representativeItem.startEndQuery)
		{
			const result = await wikidata.runTimeQueryTerm(representativeItem.startEndQuery, bundle)
			copyMultipleResult(result, function(item, result) {
				Object.assign(item, result)
			})
		}
		else
		{
			if (representativeItem.startQuery)
			{
				const result = await wikidata.runTimeQueryTerm(representativeItem.startQuery, bundle)
				copySingleResult(result, function(item, result) {
					item.start_min = result.min
					item.start_max = result.max
					item.previous = result.previous
				})
			}
			if (representativeItem.endQuery)
			{
				const result = await wikidata.runTimeQueryTerm(representativeItem.endQuery, bundle)
				copySingleResult(result, function(item, result) {
					item.end_min = result.min
					item.end_max = result.max
					item.next = result.next
				})
			}
		}
	}

	// run path queries
	console.log(`There are ${pathQueries.length} path queries.`)
	await wikidata.runPathQueries(pathQueries)

	// propagate path query results to items
	for (const item of wikidata.inputSpec.items)
	{
		if (item.startPath)
		{
			const startTime = flattenRelativeDate(wikidata.pathCache, item.startPath)
			if (startTime)
			{
				const range = wikidataToRange(startTime)
				item.start_min = range.min
				item.start_max = range.max
			}
			else
				console.error(`Date for '${item.startPath}' wasn't cached.`)
		}
		if (item.endPath)
		{
			const endTime = flattenRelativeDate(wikidata.pathCache, item.endPath)
			if (endTime)
			{
				const range = wikidataToRange(endTime)
				item.end_min = range.min
				item.end_max = range.max
			}
			else
				console.error(`Date for '${item.endPath}' wasn't cached.`)
		}
	}
})
.then(async () => {

	await mypath.ensureDirectoryForFile(outputFile)

	// write the output file
	const output = renderer.produceOutput(wikidata.inputSpec, wikidata.inputSpec.items)
	await fs.writeFile(outputFile, output, err => {
		if (err) {
			console.error(`Error writing output file:`)
			console.error(err)
		}
	});

	// write the metadata output file
	if (metadataOutputFile)
	{
		await mypath.ensureDirectoryForFile(metadataOutputFile)

		const metadataOutput = JSON.stringify(wikidata.inputSpec)
		await fs.writeFile(metadataOutputFile, metadataOutput, err => {
			if (err) {
				console.error(`Error writing metadata output file:`)
				console.error(err)
			}
		});
	}

})
.catch((reason) => {

	console.error(reason)

})
.finally(async () => { await wikidata.writeCache(); })
