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

// produces a range of moments {min,max} from a Wikidata time
function wikidataToRange(inTime)
{
	if (!inTime || !inTime.value)
	{
		// missing value
		return undefined
	}

	// moment has trouble with negative years unless they're six digits
	const date = moment.utc(inTime.value, 'YYYYYY-MM-DDThh:mm:ss')

	switch (inTime.precision)
	{
		case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8:
			const yearBase = Math.pow(10, 9 - inTime.precision)
			const roundedYear = Math.round(date.year() / yearBase) * yearBase
			return {
				min: moment({year:roundedYear}),
				max: moment({year:roundedYear + yearBase}).subtract(1, 'minute').endOf('year')
			}
		case 9: // year precision
			return { min: date.clone().startOf('year'), max: date.clone().endOf('year') }
		case 10: // month precision
			date.startOf('month')
			return { min: date.clone().startOf('month'), max: date.clone().endOf('month') }
		case 11: // day precision
			date.startOf('day')
			return { min: date.clone().startOf('day'), max: date.clone().endOf('day') }
		case 12: // hour precision
			date.startOf('hour')
			return { min: date.clone().startOf('hour'), max: date.clone().endOf('hour') }
		case 13: // minute precision
			date.startOf('minute')
			return { min: date.clone().startOf('minute'), max: date.clone().endOf('minute') }
		case 14: // second precision
			date.startOf('second')
			return { min: date.clone().startOf('second'), max: date.clone().endOf('second') }
		default:
			throw `Unrecognized date precision ${inTime.precision}`
	}
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
		assert(item.start)
		item.start = item.start.format("YYYYYY-MM-DDThh:mm:ss")
		if (item.end)
			item.end = item.end.format("YYYYYY-MM-DDThh:mm:ss")
		outputObject.items.push(item)
	}

	// group items with prev/next data into prev/next chains
	const successionChains = []
	for (const item of items)
	{
		// try to append to an existing chain
		//TODO: does not support branching chains
		var nextForChain = null
		var prevForChain = null
		for (const chain of successionChains)
		{
			if ((item.next && item.next == chain[0].entity)
				&& (chain[0].previous && item.entity == chain[0].previous))
			{
				prevForChain = chain
			}
			if ((item.previous && item.previous == chain.at(-1).entity)
				&& (chain.at(-1).next && item.entity == chain.at(-1).next))
			{
				nextForChain = chain
			}
		}

		if (nextForChain && prevForChain)
		{
			// merge chains
			nextForChain.push(item)
			if (nextForChain != prevForChain) //wtf
			{
				for (const prevItem of prevForChain) nextForChain.push(prevItem)
				const prevForChainIdx = successionChains.indexOf(prevForChain)
				successionChains.splice(prevForChainIdx, 1)
			}
		}
		else if (nextForChain)
		{
			nextForChain.push(item)
		}
		else if (prevForChain)
		{
			prevForChain.unshift(item)
		}
		else
		{
			successionChains.push([ item ])
		}

		// DEBUG: validate
		/*for (const chain of successionChains)
		{
			for (var i2 = 0; i2 < chain.length - 1; i2++)
			{
				assert(chain[i2].entity == chain[i2+1].previous)
			}
			for (var i2 = 1; i2 < chain.length; i2++)
			{
				assert(chain[i2].entity == chain[i2-1].next)
			}
		}*/
	}

	// split overlapped uncertain regions between adjacent items
	//TODO: create a shared area that visually makes it more clear that the line can slide around?
	//TODO: handle multiple entire elements that overlap
	for (const chain of successionChains)
	{
		for (var chainIndex = 0; chainIndex < chain.length - 1; chainIndex++)
		{
			var curr = chain[chainIndex]
			var next = chain[chainIndex + 1]
			if (!curr.end_min || !next.start_min) continue
			var overlapStart = moment.max(curr.end_min, next.start_min)
			var overlapEnd = moment.min(curr.end_max, next.start_max)
			if (overlapStart < overlapEnd)
			{
				var middle = moment((overlapStart.valueOf() + overlapEnd.valueOf()) / 2)
				curr.end_max = middle.clone()
				next.start_min = middle
			}
		}
	}

	// create timeline items
	// a single input item might be built of multiple timeline segments
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
		expectation.duration.avg = expectation.duration.avg ?? expectation.duration.max
		assert(expectation && expectation.duration) // expect at least a universal fallback expectation

		if (!item.start_min && !item.start_max && !item.end_min && !item.end_max)
		{
			//console.warn(`Item ${item.id} has no date data at all.`)
			continue
		}
		assert(Boolean(item.start_min) == Boolean(item.start_max))
		assert(Boolean(item.end_min) == Boolean(item.end_max))
		assert(!(item.start_min > item.start_max))
		assert(!(item.end_min > item.end_max))

		// restrict uncertainty based on expectations
		//TODO:

		// exclude items that violate itemRange constraints
		//OPT: do this at an earlier stage? (e.g. when running the first query)
		if (item.itemRange)
		{
			if (item.itemRange.min && moment(item.itemRange.min).isAfter(item.end_max))
				continue
			if (item.itemRange.max && moment(item.itemRange.max).isBefore(item.start_min))
				continue
		}

		if (item.start_max >= item.end_min)
		{
			// no certainty at all: create a single uncertain range
			outputItem.className = [ outputItem.className, 'visc-uncertain' ].join(' ')
			outputItem.start = item.start_min
			outputItem.end = item.end_max

			finalizeItem(outputItem)
			continue
		}

		if (!isRangeType)
		{
			// point type
			//TODO: support ranged boxes etc?
			outputItem.start = moment((item.start_min.valueOf() + item.start_max.valueOf()) / 2)
			if (item.end_min && item.end_max)
				outputItem.end = moment((item.end_min.valueOf() + item.end_max.valueOf()) / 2)

			finalizeItem(outputItem)
			continue
		}

		// handle end date
		if (item.end_min && item.end_max)
		{
			if (item.end_min < item.end_max)
			{
				// uncertain end

				// find lower bound of uncertain region
				const uncertainMin = item.end_min ?? outputItem.start_max
				assert(uncertainMin)
				
				// add uncertain range
				outputObject.items.push({
					id: outputItem.id + "-unc-end",
					className: [outputItem.className, "visc-uncertain", "visc-left-connection"].join(' '),
					content: item.label ? "&nbsp;" : "",
					start: uncertainMin.format("YYYYYY-MM-DDThh:mm:ss"),
					end: item.end_max.format("YYYYYY-MM-DDThh:mm:ss"),
					group: item.group,
					subgroup: outputItem.subgroup
				})

				// adjust normal range to match
				outputItem.end = uncertainMin
				outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
			}
			else
			{
				// certain end
				outputItem.end = item.end_max;
			}
		}
		else if (item.end_min && item.start_max < item.end_min)
		{
			// open-ended end with some certainty
			var tailEnd
			const useMax = expectation.duration.max ? expectation.duration.max : moment(expectation.duration.avg.asMilliseconds() * 2)
			if (item.start_max < moment().subtract(useMax))
			{
				// max "possible" is less than 'now'; it is likely this duration is not ongoing but has an unknown end
				//TODO: wikidata special 'no value' should cause the next branch to be taken
				outputItem.end = item.start_max.clone()
				tailEnd = item.start_max.clone().add(expectation.duration.avg)
			}
			else
			{
				// 'now' is within 'max' and so it is a reasonable guess that this duration is ongoing
				const avgDuration = moment.duration(expectation.duration.avg) //HACK: TODO: consistently postprocess expectations, or don't
				const actualDuration = moment.duration(moment().diff(item.start_max)) //TODO: average start here?
				var excessDuration = moment.duration(avgDuration.asMilliseconds()).subtract(actualDuration)
				excessDuration = moment.duration(Math.max(excessDuration.asMilliseconds(), avgDuration.asMilliseconds() * 0.25)) //HACK: magic number

				outputItem.end = moment()
				tailEnd = outputItem.end.add(excessDuration)
			}

			// add a "tail" item after the end
			outputObject.items.push({
				id: outputItem.id + "-tail",
				className: [outputItem.className, "visc-right-tail"].join(' '),
				content: item.label ? "&nbsp;" : "",
				start: outputItem.end.format("YYYYYY-MM-DDThh:mm:ss"),
				end: tailEnd.format("YYYYYY-MM-DDThh:mm:ss"),
				group: item.group,
				subgroup: outputItem.subgroup
			})

			outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
		}
		else
		{
			if (item.start_min && item.start_max && item.start_max > item.start_min)
			{
				// entire range is open-ended, but with an uncertain start region
				outputItem.end = item.start_max.clone()
				tailEnd = item.start_max.clone().add(expectation.duration.avg)

				// add a "tail" item after the end
				outputObject.items.push({
					id: outputItem.id + "-tail",
					className: [outputItem.className, "visc-right-tail"].join(' '),
					content: item.label ? "&nbsp;" : "",
					start: outputItem.end.format("YYYYYY-MM-DDThh:mm:ss"),
					end: tailEnd.format("YYYYYY-MM-DDThh:mm:ss"),
					group: item.group,
					subgroup: outputItem.subgroup
				})

				outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
			}
			else
			{
				// entire range is open-ended
				outputItem.start = item.start_min ?? item.start_max
				outputItem.end = outputItem.start.clone().add(expectation.duration.avg)
				outputItem.className = [ outputItem.className, 'visc-open-right' ].join(' ')
				finalizeItem(outputItem)
				continue
			}
		}
		
		// handle start date
		if (item.start_min && item.start_max)
		{
			if (item.start_max > item.start_min)
			{
				// uncertain start
				
				// find upper bound of uncertain region
				var uncertainMax
				if (item.start_max)
					uncertainMax = item.start_max
				else if (outputItem.start)
					uncertainMax = outputItem.start
				else
					uncertainMax = outputItem.end
				assert(uncertainMax)

				// add uncertain range
				outputObject.items.push({
					id: outputItem.id + "-unc-start",
					className: [outputItem.className, "visc-uncertain", "visc-right-connection"].join(' '),
					content: item.label ? "&nbsp;" : "",
					start: item.start_min.format("YYYYYY-MM-DDThh:mm:ss"),
					end: uncertainMax.format("YYYYYY-MM-DDThh:mm:ss"),
					group: item.group,
					subgroup: outputItem.subgroup
				})

				// adjust normal range to match
				//TODO: handle the entire range being uncertain
				outputItem.start = uncertainMax
				outputItem.className = [ outputItem.className, 'visc-left-connection' ].join(' ')
			}
			else
			{
				// certain start
				outputItem.start = item.start_min
			}
		}
		else if (!item.start_min)
		{
			// open-ended start
			outputItem.start = outputItem.end.clone().subtract(expectation.duration.avg)
			outputItem.className = [outputItem.className, "visc-open-left"].join(' ')
		}
		
		//TODO: missing death dates inside expected duration: solid to NOW, fade after NOW
		//TODO: accept expected durations and place uncertainly before/after those

		finalizeItem(outputItem)
	}

	delete outputObject.chronicle

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

		// Populates output items from a query result.
		// Multiple values will be treated as multiple items.
		// Also expects both start and end ranges.
		const copyMultipleResult = function(result, func)
		{
			const aggregateHelper = function(item, entityResult)
			{
				//TODO: disregard value if min and max are present? See Q33941
				var aggregateStart = {}
				aggregateStart = rangeUnion(aggregateStart, wikidataToRange(entityResult.start))
				aggregateStart = rangeUnion(aggregateStart, wikidataToRange(entityResult.start_min))
				aggregateStart = rangeUnion(aggregateStart, wikidataToRange(entityResult.start_max))

				var aggregateEnd = {}
				aggregateEnd = rangeUnion(aggregateEnd, wikidataToRange(entityResult.end))
				aggregateEnd = rangeUnion(aggregateEnd, wikidataToRange(entityResult.end_min))
				aggregateEnd = rangeUnion(aggregateEnd, wikidataToRange(entityResult.end_max))

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
					aggregateResult = rangeUnion(aggregateResult, wikidataToRange(entityResult[i].value))
					aggregateResult = rangeUnion(aggregateResult, wikidataToRange(entityResult[i].min))
					aggregateResult = rangeUnion(aggregateResult, wikidataToRange(entityResult[i].max))
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
