#!/usr/bin/env node

// Uses an input specification file to produce an output file for vis.js Timeline.

const path = require('path')
const nodeutil = require('node:util')
const assert = require('node:assert/strict');
const moment = require('moment')

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

const fs = require('fs');
const wikidata = require('./wikidata.js')
const renderer = require('./render.js')
const mypath = require("./mypath.js");
const { flattenRelativeDate, rangeUnion, rangeUnionAdv } = require('./relativeDates.js');
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
			if (!itemIds.has(item.id))
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

	// True if the item property with the specified name has any bearing on the results of the query
	// (and therefore needs to be used in the cache key)
	const isQueryProperty = function(key)
	{
		if (key == "startEndQuery" || key == "startQuery" || key == "endQuery") return true
		if (key == "previousQuery" || key == "nextQuery") return true

		//TODO: look at the queries for parameter names
		return key != "comment"
			&& key != "id"
			&& key != "content"
			&& key != "group"
			&& key != "subgroup"
			&& key != "itemQuery"
			&& key != "excludeItems"
			&& key != "type"
			&& key != "label"
			&& key != "className"
			&& key != "entity"
			&& key != "skipCache"
			&& key != "startPath" && key != "endPath"
			&& key != "startPathMin" && key != "endPathMin"
			&& key != "startPathMax" && key != "endPathMax"
			&& key != "start" && key != "end"
			&& key != "start_min" && key != "end_min"
			&& key != "start_max" && key != "end_max"
	}

	// bundle items that use the same queries
	const queryBundles = {}
	const pathQueries = []
	const pushQuery = function(queryBundles, query, item) {
		if (query)
		{
			query = wikidata.replaceQueryWildcards(query, item)
			pathQueries.push(query)
		}
		return query
	}
	for (const item of wikidata.inputSpec.items)
	{
		if (item.finished) continue

		item.startPath = pushQuery(queryBundles, item.startPath, item)
		item.startPathMin = pushQuery(queryBundles, item.startPathMin, item)
		item.startPathMax = pushQuery(queryBundles, item.startPathMax, item)
		item.endPath = pushQuery(queryBundles, item.endPath, item)
		item.endPathMin = pushQuery(queryBundles, item.endPathMin, item)
		item.endPathMax = pushQuery(queryBundles, item.endPathMax, item)

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
					aggregateResult.next = aggregateResult.next ?? entityResult[i].next
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
			if (representativeItem.previousQuery)
			{
				const result = await wikidata.runItemQueryTerm(representativeItem.previousQuery, bundle)
				for (const key in result) { result[key].previous = result[key].value; result[key].value = undefined; }
				copySingleResult(result, function(item, result) {
					item.previous = result.previous
				})
			}
			if (representativeItem.nextQuery)
			{
				const result = await wikidata.runItemQueryTerm(representativeItem.nextQuery, bundle)
				for (const key in result) { result[key].next = result[key].value; result[key].value = undefined; }
				copySingleResult(result, function(item, result) {
					item.next = result.next
				})
			}
		}
	}

	// run path queries
	console.log(`There are ${pathQueries.length} path queries.`)
	await wikidata.runPathQueries(pathQueries)

	const tryProcessLiteralDate = function(item, key)
	{
		if (item[key])
		{
			const date = moment(item[key])
			if (date.isValid()) item[key] = date
		}
	}

	// propagate path query results to items
	for (const item of wikidata.inputSpec.items)
	{
		// parse any literal dates from data into moments
		tryProcessLiteralDate(item, "start")
		tryProcessLiteralDate(item, "start_min")
		tryProcessLiteralDate(item, "start_max")
		tryProcessLiteralDate(item, "end")
		tryProcessLiteralDate(item, "end_min")
		tryProcessLiteralDate(item, "end_max")
		
		var startRange = undefined, startRangeMin = undefined, startRangeMax = undefined
		if (item.startPath)
		{
			startRange = flattenRelativeDate(wikidata.getPathCache(), item.startPath, { returnRange: true })
			if (!startRange) console.error(`Date for '${item.startPath}' wasn't cached.`)
		}
		if (item.startPathMin)
		{
			startRangeMin = flattenRelativeDate(wikidata.getPathCache(), item.startPathMin, { returnRange: true })
			if (!startRangeMin) console.error(`Date for '${item.startPathMin}' wasn't cached.`)
		}
		if (item.startPathMax)
		{
			startRangeMax = flattenRelativeDate(wikidata.getPathCache(), item.startPathMax, { returnRange: true })
			if (!startRangeMax) console.error(`Date for '${item.startPathMax}' wasn't cached.`)
		}

		if (startRangeMin && !startRangeMin.min)
		{
			console.error(`Failed to flatten date '${item.startPathMin}'`)
			continue
		}
		if (startRangeMax && !startRangeMin.max)
		{
			console.error(`Failed to flatten date '${item.startPathMax}'`)
			continue
		}

		startRange = rangeUnionAdv(startRange, startRangeMin, startRangeMax)
		if (startRange && startRange.min) item.start_min = moment(startRange.min)
		if (startRange && startRange.max) item.start_max = moment(startRange.max)
		
		var endRange = undefined, endRangeMin = undefined, endRangeMax = undefined
		if (item.endPath)
		{
			endRange = flattenRelativeDate(wikidata.getPathCache(), item.endPath, { returnRange: true })
			if (!endRange) console.error(`Date for '${item.endPath}' wasn't cached.`)
		}
		if (item.endPathMin)
		{
			endRangeMin = flattenRelativeDate(wikidata.getPathCache(), item.endPathMin, { returnRange: true })
			if (!endRangeMin) console.error(`Date for '${item.endPathMin}' wasn't cached.`)
		}
		if (item.endPathMax)
		{
			endRangeMax = flattenRelativeDate(wikidata.getPathCache(), item.endPathMax, { returnRange: true })
			if (!endRangeMax) console.error(`Date for '${item.endPathMax}' wasn't cached.`)
		}
		endRange = rangeUnionAdv(endRange, endRangeMin, endRangeMax)
		if (endRange && endRange.min) item.end_min = moment(endRange.min)
		if (endRange && endRange.max) item.end_max = moment(endRange.max)

		//if (item.start_min && !item.start_max) item.start_max = item.end_max
		//if (item.end_max && !item.end_min) item.end_min = item.start_min

		assert(!(item.start_min > item.start_max), "Item start_min is greater than start_max")
		assert(!(item.end_min > item.end_max), "Item end_min is greater than end_max")
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
