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
		"lang": { type: 'string', short: 'l', default: "en,mul" }
	}})
	
var specFile = positionals[0]
if (!specFile)
{
	console.error(`No specification file provided.`)
	console.log(`Usage: vis-chronicle INFILE [OUTFILE]`)
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

const inputSpec = require(path.join(process.cwd(), specFile))
wikidata.setInputSpec(inputSpec)
wikidata.skipCache = values["skip-wd-cache"]
wikidata.sparqlUrl = values["query-url"]
wikidata.verboseLogging = values["verbose"]
wikidata.setLang(values["lang"])
wikidata.initialize()

// produces a moment from a Wikidata time
function wikidataToMoment(inTime)
{
	if (!inTime.value)
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
		return expectation;
	}
	assert(false) // expect at least a universal fallback expectation
	return undefined
}

// produces JSON output from the queried data
function produceOutput(items)
{
	var outputObject = { items: [], groups: inputSpec.groups, options: inputSpec.options }
	for (const item of items)
	{
		var outputItem = {
			id: item.id,
			content: item.label,
			className: item.className,
			comment: item.comment,
			type: item.type
		}

		// convert fetched time to a moment
		if (item.start)
			outputItem.start = wikidataToMoment(item.start)
		if (item.end)
			outputItem.end = wikidataToMoment(item.end)

		// handle missing start or end
		if (!outputItem.start || !outputItem.end)
		{
			// look up duration expectations
			const expectation = getExpectation(item)

			assert(expectation && expectation.duration && expectation.duration.avg) // expect at least a universal fallback expectation

			if (!outputItem.start && !outputItem.end)
			{
				console.warn(`Item ${item.id} has no start or end.`)
				continue;
			}
			else if (!outputItem.end)
			{
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
					subgroup: item.subgroup ? item.subgroup : item.entity
				})

				outputItem.className = [ outputItem.className, 'visc-right-withtail' ].join(' ')
			}
			else if (!outputItem.start)
			{
				outputItem.start = outputItem.end.clone().subtract(expectation.duration.avg)

				outputItem.className = [outputItem.className, "visc-open-left"].join(' ')
			}
			//TODO: missing death dates inside expected duration: solid to NOW, fade after NOW
			//TODO: accept expected durations and place uncertainly before/after those
		}

		// convert moment to a final string
		if (outputItem.start)
			outputItem.start = outputItem.start.format("YYYYYY-MM-DDThh:mm:ss")
		if (outputItem.end)
			outputItem.end = outputItem.end.format("YYYYYY-MM-DDThh:mm:ss")

		if (item.group)
		{
			outputItem.group = item.group
			outputItem.subgroup = item.subgroup ? item.subgroup : item.entity
		}
		
		outputObject.items.push(outputItem)
	}
	return JSON.stringify(outputObject, undefined, "\t") //TODO: configure space
}

async function entryPoint() {}

entryPoint()
.then(async () => {

	await wikidata.readCache();

})
.then(async () => {

	// replace template items using their item-generating queries
	for (var i = inputSpec.items.length - 1; i >= 0; --i)
	{
		var templateItem = inputSpec.items[i]
		if (templateItem.itemQuery) //TODO: caching for item queries
		{
			inputSpec.items.splice(i, 1)
			const newItems = await wikidata.createTemplateItems(templateItem)
			for (const newItem of newItems)
				inputSpec.items.push(newItem)
		}
	}

})
.then(() => {

	var hasError = false;

	// collect all existing ids
	var itemIds = new Set()
	for (const item of inputSpec.items)
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
	for (const item of inputSpec.items)
	{
		if (!item.id)
		{
			const baseId = item.entity ? item.entity : "anonymous"
			var i = 0
			do {
				i++
				var prospectiveId = baseId + "-" + i
			} while (itemIds.has(prospectiveId));
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
	for (const item of inputSpec.items)
	{
		if (item.finished) continue

		console.log(`Processing ${item.id}...`)

		//TODO: batch queries on the same item

		if (item.startEndQuery)
		{
			const result = await wikidata.runTimeQueryTerm2(item.startEndQuery, item)
			item.start = result.start
			item.end = result.end
		}
		else
		{
			if (item.startQuery)
				item.start = await wikidata.runTimeQueryTerm(item.startQuery, item)
			if (item.endQuery)
				item.end = await wikidata.runTimeQueryTerm(item.endQuery, item)
		}
		item.finished = true
	}

})
.then(async () => {

	await mypath.ensureDirectoryForFile(outputFile)

	// write the output file
	const output = produceOutput(inputSpec.items)
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
