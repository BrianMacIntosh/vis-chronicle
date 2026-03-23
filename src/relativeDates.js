
const moment = require('moment')
const { toJewishDate, toGregorianDate, getIndexByJewishMonth } = require("jewish-date");
const wikidata = require('./wikidata');
const wikidataToRange = require('./wikidataToRange');
const assert = require("node:assert/strict")

function momentToHDate(inMoment)
{
	return toJewishDate(inMoment.toDate()) //TODO: handle TZ/time of day
}

function HDateToMoment(inHDate)
{
	return moment(toGregorianDate(inHDate)) //TODO: handle TZ/time of day
}

function durationToWikidataPrecision(duration)
{
	if (duration.milliseconds()) return 14
	else if (duration.seconds()) return 14
	else if (duration.minutes()) return 13
	else if (duration.hours()) return 12
	else if (duration.days()) return 11
	else if (duration.months()) return 10
	else return 9
}

/**
 * Combines three {min, max} objects into a range containing all of them.
 * @param {*} value Is overridden by min.min and max.max if they are present.
 * @param {*} min 
 * @param {*} max 
 * @returns 
 */
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

/**
 * Combines two {min, max} objects into a range containing both of them.
 * @param {*} a 
 * @param {*} b 
 * @returns 
 */
function rangeUnion(a, b)
{
	if (!a) return b
	if (!b) return a
	return {
		min: a.min && b.min ? moment.min(a.min, b.min) : a.min || b.min,
		max: a.max && b.max ? moment.max(a.max, b.max) : a.max || b.max
	}
}


/**
 * Breaks down a relative date path into its components.
 * @param {*} dateString 
 * @returns An array of strings, or null.
 */
function breakRelativeDate(dateString)
{
	if (!dateString) return null

	// parse out relative date components
	var match = dateString.match(wikidata.pathQueryRegex)
	if (!match)
	{
		console.error(`Failed to parse relative date '${dateString}'.`)
		return null
	}

	const dateComponents = [ match[1] ]
	var opStartIndex = 0
	const operatorString = match[2]
	if (operatorString.length > 0)
	{
		for (var i = 1; i < operatorString.length; i++)
		{
			if (operatorString[i] == '+' || operatorString[i] == '>')
			{
				dateComponents.push(operatorString.substring(opStartIndex, i))
				opStartIndex = i
			}
		}
		dateComponents.push(operatorString.substring(opStartIndex, i))
	}
	return dateComponents
}

/**
 * Flattens a relative date path string into a hard date.
 * @param {*} wikidataCache 
 * @param {*} dateString 
 * @param {*} params { returnRange:BOOL }. Result will be a range { min:STRING, max:STRING } instead.
 * @returns An object like { value:STRING, precision:INT }, or null
 */
function flattenRelativeDate(wikidataCache, dateString, params)
{
	var flatMoment = flattenRelativeDateToMoment(wikidataCache, dateString)

	// if allowed and necessary, produce a range instead of a single value
	if (params?.returnRange)
	{
		var parsedPath = breakRelativeDate(dateString)
		if (!parsedPath) return { value: null }

		const basePath = parsedPath[0]
		const wdpk = basePath.substring(0, basePath.lastIndexOf(':'))
		const qual = basePath.substring(basePath.lastIndexOf(':') + 1)
		var minQuery
		var maxQuery
		switch (qual)
		{
			case "P580":
			{
				minQuery = `${wdpk}:P1319` // earliest date
				maxQuery = `${wdpk}:P8555` // latest start date
				break
			}
			case "P582":
			{
				minQuery = `${wdpk}:P8554` // earliest end date
				maxQuery = `${wdpk}:P1326` // latest date
				break
			}
		}
		if (minQuery && maxQuery)
		{
			const minMoment = flattenRelativeDateToMoment(wikidataCache, minQuery + parsedPath.slice(1).join(''))
			const maxMoment = flattenRelativeDateToMoment(wikidataCache, maxQuery + parsedPath.slice(1).join(''))
			const value = wikidataToRange(flatMoment)
			const minRange = wikidataToRange(minMoment)
			const maxRange = wikidataToRange(maxMoment)
			const aggregateRange = rangeUnionAdv(value, minRange, maxRange)
			return {
				min: aggregateRange.min ? aggregateRange.min.format('YYYYYY-MM-DDThh:mm:ss') : null,
				max: aggregateRange.max ? aggregateRange.max.format('YYYYYY-MM-DDThh:mm:ss') : null
			}
		}
		else
		{
			const flatRange = wikidataToRange(flatMoment)
			return flatRange
				? { min: flatRange.min.format('YYYYYY-MM-DDThh:mm:ss'), max: flatRange.max.format('YYYYYY-MM-DDThh:mm:ss') }
				: { value: null }
		}
	}
	else
	{
		if (flatMoment && flatMoment.value)
		{
			flatMoment.value = flatMoment.value.format('YYYYYY-MM-DDThh:mm:ss')
		}
		return flatMoment
	}
}

/**
 * Flattens a relative date path string into a moment.
 * @param {*} wikidataCache 
 * @param {*} dateString 
 * @returns An object like { value:MOMENT, precision:INT }, or null
 */
function flattenRelativeDateToMoment(wikidataCache, dateString)
{
	var parsedPath = breakRelativeDate(dateString)
	if (!parsedPath)
	{
		return null
	}
	else if (!wikidataCache[parsedPath[0]])
	{
		console.error(`Date for '${parsedPath[0]}' wasn't cached.`)
		return null
	}
	else
	{
		const cacheEntry = wikidataCache[parsedPath[0]]
		if (cacheEntry.value && parsedPath.length > 1)
		{
			// break up operators
			const dateOperators = parsedPath.slice(1)

			// handle relative segments of date
			// About precision:
			// - The actual value is assumed to lie in a range the size of the precision
			// - This start point can be more precise than the precision (e.g. a month starting on Oct 21)

			var momentDate = moment(cacheEntry.value, 'YYYYYY-MM-DDThh:mm:ss')
			var precision = cacheEntry.precision
			//console.log(momentDate)
			for (const component of dateOperators)
			{
				if (!component)
				{
					// empty group from regex
					continue
				}
				else if (component[0] == "+")
				{
					const momentDelta = moment.duration(component.substring(1))
					momentDate = momentDate.add(momentDelta)

					// addition durations can only reduce precision
					precision = Math.min(precision, durationToWikidataPrecision(momentDelta))
				}
				else if (component[0] == ">")
				{
					// advance to the start of the next occurrence of this month/day
					const componentSplit = component.substring(1).split('!')
					if (getIndexByJewishMonth(componentSplit[0]))
					{
						const hdate = momentToHDate(momentDate)
						if (hdate.monthName == componentSplit[0])
						{
							console.warn(`zdate (originally '${dateString}') is already in '${componentSplit[0]}'.`)
						}

						if (componentSplit[1])
						{
							// by day
							hdate.monthName = componentSplit[0]
							hdate.day = parseInt(componentSplit[1])
							precision = 11
						}
						else
						{
							// by month
							hdate.monthName = componentSplit[0]
							hdate.day = 1
							precision = 10
						}

						const candidate = HDateToMoment(hdate)
						if (candidate < momentDate)
						{
							hdate.year++
							momentDate = HDateToMoment(hdate)
						}
						else
						{
							momentDate = candidate
						}
					}
					else
					{
						console.error(`Cannot advance/'>' to '${component.substring(1)}'.`)
					}
				}
				else
				{
					console.error(`Unsupported relative date operation '${component[0]}'.`)
				}

				//console.log(`${component} (${precision}): ${momentDate}`)
			}
			return { value: momentDate, precision: precision }
		}
		else
		{
			const cachedOut = {...cacheEntry}
			if (cachedOut.value) cachedOut.value = moment(cachedOut.value)
			return cachedOut
		}
	}
}

module.exports = { breakRelativeDate, flattenRelativeDate, rangeUnion, rangeUnionAdv }
