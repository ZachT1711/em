import * as htmlparser from 'htmlparser2'
import { parse } from 'jex-block-parser'
import he from 'he'
import { store } from '../store'
import {
  EM_TOKEN,
  ROOT_TOKEN,
} from '../constants'

// util
import {
  addThought,
  contextOf,
  equalPath,
  equalThoughtRanked,
  getRankAfter,
  getThought,
  getThoughtsRanked,
  hashContext,
  hashThought,
  head,
  headRank,
  nextSibling,
  pathToContext,
  removeContext,
  rootedContextOf,
  strip,
  sync,
  timestamp,
} from '../util'

// starts with '-', '—' (emdash), or '*'' (excluding whitespace)
// '*'' must be followed by a whitespace character to avoid matching *footnotes or *markdown italic*
const regexpPlaintextBullet = /^\s*(?:[-—]|\*\s)/m

// has an indented line
const regexpIndent = /^(?:\t|\s\s)/m

// body content only
const regexpBody = /[\s\S]*<body>([\s\S]+?)<\/body>[\s\S]*/gmi

// has at least one list item or paragraph
const regexpHasListItems = /<li|p>.*<\/li|p>/mi

// a list item tag
const regexpListItem = /<li>/gmi

/** Converts data output from jex-block-parser into HTML

@example
[ { scope: 'fruits',
    children:
     [ { scope: '  apple',
         children:
          [ { scope: '    gala', children: [] },
            { scope: '    pink lady', children: [] } ] },
       { scope: '  pear', children: [] },
       { scope: '  cherry',
         children: [ { scope: '    white', children: [] } ] } ] },
  { scope: 'veggies',
    children:
     [ { scope: '  kale',
         children: [ { scope: '    red russian', children: [] } ] },
       { scope: '  cabbage', children: [] },
       { scope: '  radish', children: [] } ] } ]

to:

<li>fruits<ul>
  <li>apple<ul>
    <li>gala</li>
    <li>pink lady</li>
  </ul></li>
  <li>pear</li>
  ...
</ul></li>

*/
const blocksToHtml = parsedBlocks =>
  parsedBlocks.map(block => {
    const value = block.scope.replace(regexpPlaintextBullet, '').trim()
    const childrenHtml = block.children.length > 0
      ? `<ul>${blocksToHtml(block.children)}</ul>`
      : ''
    return value || childrenHtml
      ? `<li>${value}${childrenHtml}</li>`
      : ''
  }
  ).join('')

/* Parser plaintext, indentend text, or HTML into HTML that htmlparser can understand */
const rawTextToHtml = inputText => {

  // if the input text has any <li> elements at all, treat it as HTML
  const isHTML = regexpHasListItems.test(inputText)
  const decodedInputText = he.decode(inputText)

  // use jex-block-parser to convert indentent plaintext into nested HTML lists
  const parsedInputText = !isHTML && regexpIndent.test(decodedInputText)
    ? blocksToHtml(parse(decodedInputText))
    : decodedInputText

  // true plaintext won't have any <li>'s or <p>'s
  // transform newlines in plaintext into <li>'s
  return !isHTML
    ? parsedInputText
      .split('\n')
      .map(line => `<li>${line.replace(regexpPlaintextBullet, '').trim()}</li>`)
      .join('')
    // if it's an entire HTML page, ignore everything outside the body tags
    : parsedInputText.replace(regexpBody, (input, bodyContent) => bodyContent)
}

/* Parse HTML and generates { contextIndexUpdates, thoughtIndexUpdates } that can be sync'd to state */
const importHtml = (thoughtsRanked, html) => {

  const numLines = (html.match(regexpListItem) || []).length
  const destThought = head(thoughtsRanked)
  const destValue = destThought.value
  const destRank = destThought.rank
  const thoughtIndexUpdates = {}
  const contextIndexUpdates = {}
  const importCursor = equalPath(thoughtsRanked, [{ value: EM_TOKEN, rank: 0 }])
    ? thoughtsRanked
    : contextOf(thoughtsRanked)
  const context = pathToContext(contextOf(thoughtsRanked))
  const destEmpty = destValue === '' && getThoughtsRanked(thoughtsRanked).length === 0
  const state = store.getState()
  const thoughtIndex = Object.assign({}, state.thoughtIndex)

  // keep track of the last thought of the first level, as this is where the selection will be restored to
  let lastThoughtFirstLevel = thoughtsRanked // eslint-disable-line fp/no-let

  // if the thought where we are pasting is empty, replace it instead of adding to it
  if (destEmpty) {
    thoughtIndexUpdates[hashThought('')] =
      getThought('', thoughtIndex) &&
      getThought('', thoughtIndex).contexts &&
      getThought('', thoughtIndex).contexts.length > 1
        ? removeContext(getThought('', thoughtIndex), context, headRank(thoughtsRanked))
        : null
    const contextEncoded = hashContext(rootedContextOf(thoughtsRanked))
    contextIndexUpdates[contextEncoded] = (state.contextIndex[contextEncoded] || [])
      .filter(child => !equalThoughtRanked(child, destThought))
  }

  // paste after last child of current thought
  let rank = getRankAfter(thoughtsRanked) // eslint-disable-line fp/no-let
  const next = nextSibling(destValue, context, destRank)
  const rankIncrement = next ? (next.rank - rank) / numLines : 1
  let lastValue // eslint-disable-line fp/no-let

  // import notes from WorkFlowy
  let insertAsNote = false // eslint-disable-line fp/no-let

  const parser = new htmlparser.Parser({
    onopentag: (tagname, attributes) => {
      // when there is a nested list, add the last thought to the cursor so that the next imported thought will be added in the last thought's context. The thought is empty until the text is parsed.
      // lastValue is also used during ontext to know if a note is being inserted
      if (lastValue && (tagname === 'ul' || tagname === 'ol')) {
        importCursor.push({ value: lastValue, rank }) // eslint-disable-line fp/no-mutating-methods
      }

      if (attributes.class === 'note') {
        insertAsNote = true
      }
    },
    ontext: text => {

      const valueOriginal = text.trim()

      if (valueOriginal.length === 0) return

      // a value that can masquerade as a note
      const value = insertAsNote ? '=note' : valueOriginal

      const context = importCursor.length > 0
        ? pathToContext(importCursor).concat(insertAsNote ? lastValue : [])
        : [ROOT_TOKEN]

      // increment rank regardless of depth
      // ranks will not be sequential, but they will be sorted since the parser is in order
      const thoughtNew = addThought({
        thoughtIndex,
        value,
        rank,
        context
      })

      // save the first imported thought to restore the selection to
      if (importCursor.length === thoughtsRanked.length - 1) {
        lastThoughtFirstLevel = { value, rank }
      }

      // update thoughtIndex
      // keep track of individual thoughtIndexUpdates separate from thoughtIndex for updating thoughtIndex sources
      thoughtIndex[hashThought(value)] = thoughtNew
      thoughtIndexUpdates[hashThought(value)] = thoughtNew

      // update contextIndexUpdates
      const contextEncoded = hashContext(context)
      contextIndexUpdates[contextEncoded] = contextIndexUpdates[contextEncoded] || state.contextIndex[contextEncoded] || []
      contextIndexUpdates[contextEncoded].push({ // eslint-disable-line fp/no-mutating-methods
        value,
        rank,
        lastUpdated: timestamp()
      })

      // add note to new thought
      if (insertAsNote) {

        const contextNote = context.concat(value)
        const valueNote = valueOriginal

        const thoughtNote = addThought({
          thoughtIndex,
          value: valueNote,
          rank: 0,
          context: contextNote
        })

        thoughtIndex[hashThought(valueNote)] = thoughtNote
        thoughtIndexUpdates[hashThought(valueNote)] = thoughtNote

        // update contextIndexUpdates
        const contextEncoded = hashContext(contextNote)
        contextIndexUpdates[contextEncoded] = contextIndexUpdates[contextEncoded] || state.contextIndex[contextEncoded] || []
        contextIndexUpdates[contextEncoded].push({ // eslint-disable-line fp/no-mutating-methods
          value: valueNote,
          rank: 0,
          lastUpdated: timestamp()
        })
      }
      // only update lastValue for non-notes. Otherwise the next thought will incorrectly be added to the note and not the thought itself.
      else {
        // update lastValue and increment rank for next iteration
        lastValue = value
        rank += rankIncrement
      }
    },
    onclosetag: tagname => {
      if (tagname === 'ul' || tagname === 'ol') {
        importCursor.pop() // eslint-disable-line fp/no-mutating-methods
      }
      // reset insertAsNote
      else if (insertAsNote) {
        insertAsNote = false
      }
    }
  })

  parser.write(html)
  parser.end()

  return {
    contextIndexUpdates,
    lastThoughtFirstLevel,
    thoughtIndexUpdates,
  }
}

/** Imports the given text or html into the given thoughts
  @param preventSetCursor    Prevents the default behavior of setting the cursor to the last thought at the first level
*/
export const importText = (thoughtsRanked, inputText, { preventSync, preventSetCursor } = {}) => {
  const text = rawTextToHtml(inputText)
  const numLines = (text.match(regexpListItem) || []).length
  const destThought = head(thoughtsRanked)
  const destValue = destThought.value
  const destRank = destThought.rank

  // if we are only importing a single line of text, then simply modify the current thought
  if (numLines === 1) {
    const focusOffset = window.getSelection().focusOffset
    const newText = (destValue !== '' ? ' ' : '') + strip(text, { preserveFormatting: true })
    const selectedText = window.getSelection().toString()

    const newValue = destValue.slice(0, focusOffset) + newText + destValue.slice(focusOffset + selectedText.length)

    store.dispatch({
      type: 'existingThoughtChange',
      oldValue: destValue,
      newValue,
      context: rootedContextOf(pathToContext(thoughtsRanked)),
      thoughtsRanked
    })

    if (preventSetCursor && thoughtsRanked) {
      store.dispatch({
        type: 'setCursor',
        thoughtsRanked: contextOf(thoughtsRanked).concat({ value: newValue, rank: destRank }),
        offset: focusOffset + newText.length
      })
    }
  }
  else {

    const { lastThoughtFirstLevel, thoughtIndexUpdates, contextIndexUpdates } = importHtml(thoughtsRanked, text)

    if (!preventSync) {
      sync(thoughtIndexUpdates, contextIndexUpdates, {
        forceRender: true,
        callback: () => {
          // restore the selection to the first imported thought
          if (!preventSetCursor && lastThoughtFirstLevel && lastThoughtFirstLevel.value) {
            store.dispatch({
              type: 'setCursor',
              thoughtsRanked: contextOf(thoughtsRanked).concat(lastThoughtFirstLevel),
              offset: lastThoughtFirstLevel.value.length
            })
          }
        }
      })
    }

    return Promise.resolve({
      contextIndexUpdates,
      thoughtIndexUpdates,
    })
  }

  return Promise.resolve({})
}
