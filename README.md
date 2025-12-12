# vis-chronicle

vis-chronicle is a tool to generate web-based timelines from Wikidata SPARQL queries. You feed the tool a specification JSON file that describes what items to put on the timeline. The tool gathers the needed data from Wikidata and produces a JSON file suitable for feeding directly to [vis-timeline](https://github.com/visjs/vis-timeline).

## Example

This specification file generates a timeline containing the lifespans of every United States president.

```json
{
	"groups":
	[
		{
			"id": "presidents",
			"content": ""
		}
	],
	"options":
	{
		"width": "100%",
		"groupHeightMode": "fixed",
		"preferZoom": false,
		"showCurrentTime": true
	},
	"queryTemplates":
	{
		"dateOfBirth": "{entity} p:P569/psv:P569 {_OUTVAR}.",
		"dateOfDeath": "{entity} p:P570/psv:P570 {_OUTVAR}."
	},
	"items":
	[
		{
			"comment": "All United States presidents",
			"itemQuery": "{_OUTVAR} wdt:P39 wd:Q11696. {_OUTVAR} wdt:P31 wd:Q5.",
			"group": "presidents",

			"startQuery": "#dateOfBirth",
			"endQuery": "#dateOfDeath"
		},
		{
			"label": "Ed Kealty (fictional)",
			"entity": "Q5335019",
			"startQuery": "#dateOfBirth",
			"endQuery": "#dateOfDeath"
		}
	]
}

```

`groups` and `options` are transparently passed through for vis-timeline - see the vis-timeline documentation.

`queryTemplates` contains template queries to be re-used by multiple items. vis-chronicle comes with a few template queries by default. Template queries use `{_OUTVAR}` to represent the output value. Also, any format variable like `{format}` will be replaced by the same-named value on the item entry, allowing templates to be parameterized.

`items` contains any number of items to generate. An item can be a single, literal item, or a multi-item generator (using `itemQuery`).

Item properties:
* `label`: Literal items only. Display label for the item. Can contain HTML.
* `itemQuery`: Generators only. A SPARQL query segment to select all the items that should be generated. `{_OUTVAR}` stands in for the ouput variable. Item labels are automatically fetched from Wikidata.
* `group`: The vis-timeline group to put the item(s) in.
* `className`: CSS class to apply to the timeline div.
* `type`: vis-timeline type of the item.
* `startQuery`: A SPARQL query segment that selects the desired start time of the object. Can be a query term like `Q5335019 p:P569/psv:P569 {_OUTVAR}.` or a template query like `#dateOfBirth`.
* `endQuery`: Same as `startQuery`, but for the end time.
