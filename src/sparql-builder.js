
const assert = require('node:assert/strict')

module.exports = class SparqlBuilder
{
	constructor()
	{
		this.outParams = []
		this.queryTerms = []
	}

	// Adds an output parameter to the query
	addOutParam(paramName)
	{
		//TODO: validate name more
		assert(paramName)
		if (this.outParams.indexOf(paramName) < 0)
		{
			this.outParams.push(paramName)
		}
	}

	addQueryTerm(term)
	{
		assert(term)
		this.queryTerms.push(term)
	}

	addWikibaseLabel(lang)
	{
		if (!lang) lang = "mul"
		this.addQueryTerm(`SERVICE wikibase:label{bd:serviceParam wikibase:language "${lang}".}`)
	}

	addOptionalQueryTerm(term)
	{
		assert(term)
		this.queryTerms.push(`OPTIONAL{${term}}`)
	}

	addTimeTerm(term, valueVar, timeVar, precisionVar)
	{
		assert(term)
		
		this.addOutParam(timeVar)
		this.addOutParam(precisionVar)
		this.addQueryTerm(`${term} ${valueVar} wikibase:timeValue ${timeVar}. ${valueVar} wikibase:timePrecision ${precisionVar}.`)
	}

	addOptionalTimeTerm(term, valueVar, timeVar, precisionVar)
	{
		assert(term)
		
		this.addOutParam(timeVar)
		this.addOutParam(precisionVar)
		this.addOptionalQueryTerm(`${term} ${valueVar} wikibase:timeValue ${timeVar}. ${valueVar} wikibase:timePrecision ${precisionVar}.`)
	}

	build()
	{
		assert(this.outParams.length > 0)
		assert(this.queryTerms.length > 0)

		//TODO: prevent injection
		return `SELECT ${this.outParams.join(" ")} WHERE{${this.queryTerms.join(" ")}}`
	}
}
