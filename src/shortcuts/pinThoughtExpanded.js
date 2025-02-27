import { store } from '../store'
import pinThoughtExpanded from '../action-creators/pinThoughtExpanded'

// components
import { PinIcon } from '../components/icons/PinIcon'

export default {
  id: 'pinThoughtExpanded',
  name: 'Pin Thought',
  description: 'Pinned thoughts remain expanded even when you move the focus.',
  svg: PinIcon,
  exec: () => {
    const state = store.getState()
    if (state.cursor) {
      pinThoughtExpanded(state.cursor)
    }
  }
}
