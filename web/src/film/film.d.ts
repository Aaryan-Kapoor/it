// What the site uses of the launch film's drawing code (film.js, which is made from the film's
// own source and is not edited here): the things It is shown being, each a stretch of the film
// drawn on a canvas.

/** One thing It can be: a card that opens, plays what the person does and what the agent does in answer, and closes. */
export interface FilmCard {
  /** Its name among the film's things, such as `whiteboard`. */
  key: string
  /** As the headline says it: "a whiteboard". */
  noun: string
  /** The agent whose name is on the plate. */
  by: string
  /** The colour behind the card, and whether that colour is a dark one. */
  field: string
  dark: boolean
  /** How many seconds of film pass in a second. */
  rate: number
  /** Where in the film the card begins, where its exchange is over, and where it has closed. */
  a: number
  end: number
  out: number
  /** The middle of the card in the film's own space, and how much of that space it needs. */
  cx: number
  cy: number
  vw: number
  vh: number
  /** When the person has acted and what they did, and when the agent has answered and what it did. */
  you: [number, string]
  did: [number, string]
  draw(ctx: CanvasRenderingContext2D, t: number): void
}

export const film: {
  cards: FilmCard[]
  /** The colour of the paper everything in the film lies on. */
  paper: string
  /** Loads the film's fonts and lays out its things. Nothing is drawn before it has settled. */
  ready(): Promise<unknown>
  /** A context whose shadows are as large against the drawing as they were in the film: set `_k` on it to the scale drawn at. */
  scaled(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D & { _k: number }
}
