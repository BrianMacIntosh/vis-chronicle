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
		"cachebuster": { type: 'string', default: undefined}
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

const moment = require('moment')
const fs = require('fs');
const wikidata = require('./wikidata.js')
const mypath = require("./mypath.js")
const globalData = require("./global-data.json")

function postprocessDuration(duration)
{
	if (duration.min)
		duration.min = moment.duration(duration.min)
	if (duration.max)
		duration.max = moment.duration(duration.max)
	if (duration.avg)
		duration.avg = moment.duration(duration.avg)
	return duration
}
function postprocessGlobalData()
{
	for (const expectation of globalData.expectations)
	{
		if (expectation.duration)
		{
			postprocessDuration(expectation.duration)
		}
	}
}
postprocessGlobalData()

wikidata.skipCache = values["skip-wd-cache"]
wikidata.cacheBuster = values["cachebuster"]
wikidata.sparqlUrl = values["query-url"]
wikidata.verboseLogging = values["verbose"]
wikidata.setLang(values["lang"])
wikidata.initialize()

// produces a moment from a Wikidata time
function wikidataToMoment(inTime)
{
	if (!inTime || !inTime.value)
	{
		// missing value
		return undefined
	}

	// moment has trouble with negative years unless they're six digits
	const date = moment.utc(inTime.value, 'YYYYYY-MM-DDThh:mm:ss')

	//TODO: do something nice in the GUI to indicate imprecision of times
	switch (inTime.precision)
	{
		case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8: case 9:
			const yearBase = Math.pow(10, 9 - inTime.precision)
			const roundedYear = Math.round(date.year() / yearBase) * yearBase
			return date.year(roundedYear).startOf('year')
		case 10: // month precision
			return date.startOf('month')
		case 11: // day precision
			return date.startOf('day')
		case 12: // hour precision
			return date.startOf('hour')
		case 13: // minute precision
			return date.startOf('minute')
		case 14: // second precision
			return date.startOf('second')
		default:
			throw `Unrecognized date precision ${inTime.precision}`
	}
}

function getExpectation(item)
{
	if (item.expectedDuration)
	{
		return { "duration": item.expectedDuration };
	}

	for (const expectation of globalData.expectations)
	{
		if (expectation.startQuery && item.startQuery != expectation.startQuery)
		{
			continue;
		}
		if (expectation.endQuery && item.endQuery != expectation.endQuery)
		{
			continue;
		}
		if (expectation.startEndQuery && item.startEndQuery != expectation.startEndQuery)
		{
			continue;
		}
		return expectation;
	}
	assert(false) // expect at least a universal fallback expectation
	return undefined
}

// produces JSON output from the queried data
function produceOutput(items)
{
	const finalizeItem = function(item)
	{
		if (item.start)
			item.start = item.start.format("YYYYYY-MM-DDThh:mm:ss")
		if (item.end)
			item.end = item.end.format("YYYYYY-MM-DDThh:mm:ss")
		outputObject.items.push(item)
	}

	var outputObject = { items: [], groups: wikidata.inputSpec.groups, options: wikidata.inputSpec.options }
	for (const item of items)
	{
		var outputItem = {
			id: item.id,
			content: item.label,
			className: item.className,
			comment: item.comment,
			type: item.type
		}
		if (item.group)
		{
			outputItem.group = item.group
			outputItem.subgroup = item.subgroup ? item.subgroup : item.entity
		}

		const isRangeType = !outputItem.type || outputItem.type == "range" || outputItem.type == "background"

		// for debugging
		outputItem.className = [ outputItem.className, item.entity ].join(' ')
		
		// look up duration expectations
		const expectation = getExpectation(item)

		assert(expectation && expectation.duration && expectation.duration.avg) // expect at least a universal fallback expectation

		if (!item.start && !item.end
			&& !item.start_min && !item.start_max
			&& !item.end_min && !item.end_max)
		{
			console.warn(`Item ${item.id} has no date data at all.`)
			continue;
		}
		
		outputItem.start = wikidataToMoment(item.start)
		outputItem.end = wikidataToMoment(item.end)
		const start_min = item.start_min ? wikidataToMoment(item.start_min) : outputItem.start
		const start_max = item.start_max ? wikidataToMoment(item.start_max) : outputItem.start
		const end_min = item.end_min ? wikidataToMoment(item.end_min) : outputItem.end
		const end_max = item.end_max ? wikidataToMoment(item.end_max) : outputItem.end

		// no certainty at all
		if (start_max >= end_min)
		{
			outputItem.className = [ outputItem.className, 'visc-uncertain' ].join(' ')
			outputItem.start = start_min
			outputItem.end = end_max

			finalizeItem(outputItem)
			continue;
		}

		if (!isRangeType)
		{
			finalizeItem(outputItem)
			continue;
		}

		// handle end date
		if (end_min && end_max && end_min < end_max)
		{
			// uncertain end

			// find lower bound of uncertain region
			var uncertainMin
			if (item.end_min)
				uncertainMin = end_min
			else if (outputItem.end)
				uncertainMin = outputItem.end
			else
				uncertainMin = outputItem.start //TODO: use min/max start
			assert(uncertainMin)
			
			// add uncertain range
			outputObject.items.push({
				id: outputItem.id + "-unc-end",
				className: [outputItem.className, "visc-uncertain", "visc-left-connection"].join(' '),
				content: item.label ? "&nbsp;" : "",
				start: uncertainMin.format("YYYYYY-MM-DDThh:mm:ss"),
				end: end_max.format("YYYYYY-MM-DDThh:mm:ss"),
				group: item.group,
				subgroup: outputItem.subgroup
			})

			// adjust normal range to match
			outputItem.end = uncertainMin
			outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
		}
		else if (!outputItem.end)
		{
			// open-ended end
			const useMax = expectation.duration.max ? expectation.duration.max : moment(expectation.duration.avg.asMilliseconds() * 2)
			if (outputItem.start.clone().add(useMax) < moment())
			{
				// 'max' is less than 'now'; it is likely this duration is not ongoing but has an unknown end
				//TODO: accomodate wikidata special 'no value'
				outputItem.end = outputItem.start.clone().add(expectation.duration.avg)
			}
			else
			{
				// 'now' is within 'max' and so it is a reasonable guess that this duration is ongoing
				outputItem.end = moment()
			}

			const avgDuration = moment.duration(expectation.duration.avg) //HACK: TODO: consistently postprocess expectations, or don't
			const actualDuration = moment.duration(outputItem.end.diff(outputItem.start))
			var excessDuration = moment.duration(avgDuration.asMilliseconds()).subtract(actualDuration)
			excessDuration = moment.duration(Math.max(excessDuration.asMilliseconds(), avgDuration.asMilliseconds() * 0.25))

			// add a "tail" item after the end
			outputObject.items.push({
				id: outputItem.id + "-tail",
				className: [outputItem.className, "visc-right-tail"].join(' '),
				content: item.label ? "&nbsp;" : "",
				start: outputItem.end.format("YYYYYY-MM-DDThh:mm:ss"),
				end: outputItem.end.clone().add(excessDuration).format("YYYYYY-MM-DDThh:mm:ss"), //HACK: magic number
				group: item.group,
				subgroup: outputItem.subgroup
			})

			outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
		}
		
		// handle start date
		if (start_min && start_max && start_max > start_min)
		{
			// uncertain start
			
			// find upper bound of uncertain region
			var uncertainMax
			if (item.start_max)
				uncertainMax = start_max
			else if (outputItem.start)
				uncertainMax = outputItem.start
			else
				uncertainMax = outputItem.end //TODO: use min/max end
			assert(uncertainMax)

			// add uncertain range
			outputObject.items.push({
				id: outputItem.id + "-unc-start",
				className: [outputItem.className, "visc-uncertain", "visc-right-connection"].join(' '),
				content: item.label ? "&nbsp;" : "",
				start: start_min.format("YYYYYY-MM-DDThh:mm:ss"),
				end: uncertainMax.format("YYYYYY-MM-DDThh:mm:ss"),
				group: item.group,
				subgroup: outputItem.subgroup
			})

			// adjust normal range to match
			outputItem.start = uncertainMax
			outputItem.className = [ outputItem.className, 'visc-left-connection' ].join(' ')
		}
		else if (!outputItem.start)
		{
			// open-ended start
			outputItem.start = outputItem.end.clone().subtract(expectation.duration.avg)
			outputItem.className = [outputItem.className, "visc-open-left"].join(' ')
		}
		
		//TODO: missing death dates inside expected duration: solid to NOW, fade after NOW
		//TODO: accept expected durations and place uncertainly before/after those

		finalizeItem(outputItem)
	}
	return JSON.stringify(outputObject, undefined, "\t") //TODO: configure space
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
		if (templateItem.itemQuery) //TODO: caching for item queries
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

	// run all the Wikidata queries

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
	}

	// bundle items that use the same queries
	const queryBundles = {}
	for (const item of wikidata.inputSpec.items)
	{
		if (item.finished) continue

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

		const copyResult = function(result, func)
		{
			for (const entityId in result)
			{
				var entityResult = result[entityId]

				// there may be multiple source items making the same query
				for (const item of bundle)
				{
					if (item.entity == entityId)
					{
						if (entityResult instanceof Array)
						{
							// clone the item for each result beyond the first
							for (var i = 1; i < entityResult.length; ++i)
							{
								const newItem = structuredClone(item)
								newItem.id = `${newItem.id}-v${i}`
								wikidata.inputSpec.items.push(newItem) //HACK: modifying original array
								func(newItem, entityResult[i])
								newItem.finished = true
							}

							// populate the first result into the original item
							entityResult = entityResult[0]
						}
						
						func(item, entityResult)
						item.finished = true
					}
				}
			}
		}

		if (representativeItem.startEndQuery)
		{
			const result = await wikidata.runTimeQueryTerm(representativeItem.startEndQuery, bundle)
			copyResult(result, function(item, result) {
				Object.assign(item, result)
			})
		}
		else
		{
			if (representativeItem.startQuery)
			{
				const result = await wikidata.runTimeQueryTerm(representativeItem.startQuery, bundle)
				copyResult(result, function(item, result) {
					item.start = result.value;
					item.start_min = result.min;
					item.start_max = result.max;
				})
			}
			if (representativeItem.endQuery)
			{
				const result = await wikidata.runTimeQueryTerm(representativeItem.endQuery, bundle)
				copyResult(result, function(item, result) {
					item.end = result.value;
					item.end_min = result.min;
					item.end_max = result.max;
				})
			}
		}
	}
})
.then(async () => {

	await mypath.ensureDirectoryForFile(outputFile)

	// write the output file
	const output = produceOutput(wikidata.inputSpec.items)
	await fs.writeFile(outputFile, output, err => {
		if (err) {
			console.error(`Error writing output file:`)
			console.error(err)
		}
	});

})
.catch((reason) => {

	console.error(reason)

})
.finally(async () => { await wikidata.writeCache(); })
