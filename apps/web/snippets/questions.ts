import { choice, listen, noul, score } from "jev-events";
import { twitch } from "@jev-events/twitch";

const chat = listen(twitch.chat("mychannel"), {
  // choice: exactly one label wins.
  // Events: "kind:question", "kind:hype" and "kind:other".
  kind: choice("What is this chat message mainly doing?", {
    question: "Asks the streamer a genuine question",
    hype: "Cheers, celebrates or reacts with excitement",
    other: null,
  }),
  // noul: the probability that the answer is yes. Event: "spoiler"
  spoiler: noul("Does this message reveal the ending of Elden Ring?"),
  // score: a position on your own scale, from 0 to 3 here. Event: "toxicity"
  toxicity: score("How toxic is this message toward other people?", [
    "Friendly or neutral",
    "Rude, but not aimed at anyone",
    "Insulting or mean toward someone",
    "Harassment, slurs or threats",
  ]),
});

// Every answer rides along, such as the probability of each kind label.
chat.on("kind:question", (e) => console.log(e.answers.kind.probabilities));
chat.on("spoiler", { min: 0.8 }, (e) => console.log(e.trigger.probability));
chat.on("toxicity", { atLeast: 2 }, (e) => console.log(e.trigger.score));

// @ts-expect-error there is no "kind:spoiler": typos are compile errors
chat.on("kind:spoiler", () => {});
