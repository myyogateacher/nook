/**
 * The passphrase word list (vault plan §6.7, D230): 2,048 common English words of 3 to 7 lowercase
 * letters, written for Nook (no third-party list), so each word carries exactly 11 bits. Sorted and
 * unique; tests/vaultGenerator.test.ts checks both and the count.
 */
const WORDS = `
abbey abide able acid acorn acre act actor adapt add adobe adore advice aerial affair afford after again age
agent agile aglow agree ahead aid aim air airport aisle alarm album alder alert alien alike alive alley allow
alloy almond aloft alone alpha alpine also alter amber amble ample amuse anchor angel anger angle animal
ankle annual answer antler anvil apart apex apple apron aqua arbor arch arctic area arena argue argyle arise
arm armor army aroma arrow art ash ashen aside ask aspen aspire asset atlas atom atrium attic audio audit
august autumn avenue avian avid avoid awake award aware awful awning axis azure back bacon badge badger bag
bagel bait bake baker balance bald ball balsam bamboo banana band banjo bank banner bar barber bare barge
bark barley barn barrel basalt base basil basin basket bat batch bath bayou beach beacon bead beam bean bear
beard beast beat beauty beaver bed bee beef beetle begin behave bell bellow belly belt bench bend beret berry
best better bias bicycle bid big bike bill bind birch bird birth biscuit bison bistro bit bite black blade
blank blanket blast blaze blend bless blimp blind blink bliss block blond blood bloom blossom blouse blue
bluff blunt blur blush board boat body boil bold bolt bond bone bonfire bongo bonus book boost boot border
borrow boss bottle bottom bounce bow bowl box brain brake bramble branch brand brandy brass brave breach
bread break breath breeze brick bride bridge brief bright brim brine bring brisk broad broken bronze brook
broom brown brush bubble bucket buckle bud budget buffalo bug bugle build bulb bulk bull bundle bunker burger
burn burrow burst bus bush busy butte butter button buyer buzz cabana cabin cable cactus caddie cadet cage
cairn cake calico calm camel cameo camera camp canal candle candy cane canoe canopy canvas canyon cape caper
capital captain car carafe carbon card cargo caribou carpet carrot carry cart carve case cash cashew castle
casual cat catalog catch cattle cause cave cavern cedar ceiling celery cell cellar cement census cereal chair
chalet chalk change channel chapel chapter charge chariot chart chase cheap check cheek cheese cheetah chef
cherry chess chest chicken chief child chime chimney chin chip chisel choice choir chop chorus chunk cider
cinder cinema circle citrus city civic civil claim clam clamp clap clarify class claw clay clean clerk clever
click client cliff climb clinic clip clock close cloth cloud clover clown club clue cluster coach coast coat
cobalt cobble cocoa coconut cocoon code coffee coin cold collar color column combine comet comfort comic
common company compass concert condor cone confirm connect control cook cool copper copy coral core corn
corner correct corsage cosmos cost cottage cotton couch cougar country couple course cousin cove cover coyote
crab crack cradle craft cram crane crash crater crawl crayon crazy cream credit creek crest crew cricket
crisp critic crocus crop cross crouch crowd crown crucial cruise crumb crumble crunch crush crust cry crystal
cube cubic cuckoo cumin cup cupola curious current curtain curve cushion custom cute cycle cypress dahlia
daily dairy daisy dance danger dapper dare dark dash data date dawn day deal debate debris decade decide deck
decline decor decoy deer defense define degree delay deliver delta demand denim dense deny depart depend
deposit depot depth deputy derive desert design desk detail detect device devote dew diamond diary dice
diesel diet digital dignity dilemma dingo dinner direct dirt dish dismiss display divert divide dizzy dock
doctor dog doll dolphin domain donate donkey donor doodle door dory dose double dove draft dragon drama draw
dream dress drift drill drink drip drive drizzle drop drum dry duck dune during dusk dust duty dwarf dynamic
eager eagle early earn earth easel east easy echo ecology economy edge edit educate eel effort egg eight
either elbow elder elegant element elite elm else embark ember embody embrace emerge emotion employ empower
emu enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich
enroll ensure enter entire entry envoy episode epoch equal equip era erase ermine erode erosion error erupt
escape essay essence estate eternal ethics evoke evolve exact example excess excite exclude excuse execute
exhaust exhibit exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fable
fabric face faculty fade faint faith falcon fall false fame family famous fan fancy fantasy farm fashion fat
fatigue fault fawn feather feature federal fee feed feel female fence fennel fern ferry fetch fever few fiber
fiction fiddle field fig figure file film filter final finch find fine finger finish fire firm first fiscal
fish fit fitness fix fjord flag flame flash flat flavor flee flight flint flip float flock floor flower fluid
flush flute fly foal foam focus fog foil fold follow fondue food foot force forest forge forget fork fortune
forum forward fossil foster found fox fragile frame fresh friend frigate fringe frog front frost frown frozen
fruit fudge fuel fun funny furnace future gable gadget gain galaxy gallery galley game gap garage garbage
garden garlic garment garnet gas gasp gate gather gauge gaze gazelle gecko general genius genre gentle
genuine gesture geyser ghost giant gift giggle ginger giraffe give glacier glad glade glance glare glass glen
glide glimpse globe glory glove glow glue gnome goat goblet gold gondola good goose gorilla gourd govern gown
grab grace grain granite grant grape grass gravel gravity great green grid grit grocery group grove grow
grunt guard guess guide guitar gull gumbo gust gym habit hair half hamlet hammer hammock hamster hand happy
harbor hard harp harvest hat hatch have haven hawk hazel head health heart heavy height hello helmet help hen
hero heron hickory hidden high hill hint hip hire history hive hobby hockey hold hole holiday hollow holly
home honey hood hope horn hornet horse host hotel hour hover hub huge human humble humor hundred hungry hunt
hurdle hurry husky hybrid ice icon idea idle igloo ignore image imitate immense immune impact impose improve
impulse inch include income index indoor inflict inform inhale inherit initial inject inlet inner input
inquiry insect inside inspire install intact into invest invite involve iris iron island isolate issue item
ivory jacket jaguar jar jasmine jazz jealous jeans jelly jetty jewel jigsaw job join joke journey joy judge
juice jump jungle juniper junk just kayak keen keep kelp kernel kestrel ketchup kettle key kick kidney kind
kingdom kiss kit kitchen kite kitten kiwi knee knife knock knoll know koala lab label labor ladder lagoon
lake lamp lantern laptop larch large lark lasso latch later lattice laugh laundry laurel lava law lawn layer
leader leaf learn leave lecture left leg legal legend leisure lemon lemur lend length lens leopard lesson
letter level liberty library license life lift light like lilac lily limb limit linen link lion liquid list
little live lizard llama load loan lobster local lock lodge loft logic lonely long loop lotus loud lounge
love loyal lucky luggage lumber lunar lunch luxury lynx lyrics macaw machine mad magic magnet magpie maid
mail main major make mallet mammal manage mandate mango manor mansion mantle manual maple marble march margin
marine market marsh marten mask mass master match math matrix matter maximum maze meadow mean measure meat
medal media melody melon melt member memory mention menu mercy merge merit merry mesa mesh metal meteor
method middle milk mimic mind minnow minor mint minute mirror miss mitten mix mixed moat mobile mocha model
modify molar mole moment monkey month moon moose moral more moss moth motion motor mouse move movie much
muffin mule mural muscle museum music musket must mutual myself myth name napkin narrow nation nature near
neck nectar need needle nerve nest net never news next nice nickel night nimbus noble noise nomad noodle
normal north nose note notice nougat novel now number nurse nut nutmeg oak oasis obey object oblige oboe
obtain occur ocean ocelot odor off offer office often oil okay old olive omit once one onion online only onyx
opal open opera oppose option orange orbit orchid order organ orient osprey other otter outer output oval
oven over owl own owner oxygen oyster ozone pact paddle page pagoda pair palace palm panda panel paper parade
parent park parka parrot party pass pastel patch path patrol pause pave peace peanut pear pebble pecan pelt
pen pencil peony people pepper perch permit person pet petal pewter phone photo phrase piano picnic piece
pier pig pigeon pill pilot pine pink pipe pitch pizza place planet plate play plaza please pledge pluck plug
plum plunge poem poet point polar pole polka poncho pond pony pool poplar porch post potato powder power
praise prefer pretty price pride print prism prize profit proof proud public puffin pull pulp pulse punch
pupil puppy purity purse push put puzzle quail quarry quartz quick quill quince quit quiz quote rabbit race
rack radar radio radish raft rail rain raise raisin rally ramp ranch random range rapid rare rate rather
raven raw razor ready real reason rebel recall recipe record reduce reef reform refuse region regret reject
relax relic relief rely remain remind remove render renew rent reopen repair repeat report rescue resist
result retire return reveal review reward rhythm rib ribbon rice rich ride ridge right rigid ring ripple risk
ritual rival river road roast robin robot robust rocket rodeo roof rookie room rose rotate rough round route
royal rubber rug rule run rune runway rural rustic saddle safe sage sail salad salmon salon salsa salt salute
same sample sand sauce save say scale scan scare scarf scene scheme school scone scout scrap screen script
scrub sea search season seat second secret seed seek select sell sense series settle setup seven shadow shaft
shale share shed shell shield shift shine ship shiver shock shoe shoot shop short shove shrimp shrub shrug
shy side siege sierra sight sign silent silk silly silo silver simple since sing siren six size skate sketch
ski skiff skill skin skirt skull slab slam sleep sleet slice slide slight slim slogan sloop slot slow slush
small smart smile smock smoke smooth snack snail snake snap sniff snow soap soccer social sock soda soft
solar solid solve song sonnet soon sorrel sorry sort soul sound soup source south space spare spawn speak
speed spell spend sphere spice spider spike spin spirit split spoil spoon sport spot spray spread spring
spruce spy square squash stable staff stage stairs stamp stand start state stay steak steel stem step stereo
stick still sting stock stone stool stork story stove street strike strong stuff style submit subway such
sudden suffer sugar suit summer summit sun sunny sunset super supply sure surge survey swamp swan swap swarm
swear sweet swift swim swing switch symbol syrup system tabby table tackle taffy tag tail talent talk talon
tango tank tape tapir target task tassel taste taxi teach teacup teal team tell ten tenant tennis tent term
test text thank that theme then theory there they thing this three thrive throw thumb thyme ticket tide tiger
tilt timber time tiny tip tired tissue title toast today toe token tomato tone tongue tool tooth top topaz
topic topple torch toss total totem toward tower town toy track trade tragic train trap trash travel tray
treat tree trend trial tribe trick trim trip trophy trout truck true truly trust truth try tube tulip tumble
tuna tundra tunnel turban turkey turn turnip turtle tusk twelve twenty twice twig twin twist two type umber
unable under undo unfair unfold unique unit unlock until unveil update uphold upon upper upset urban urge
usage use used useful usual vacant vacuum vague valid valley valor valve van vanish vapor vast vault velvet
vendor venue verb verify very vessel viable video view viola violin virus visa visit vista visual vital vivid
vocal voice void vole volume vote voyage waffle wage wagon wait walk wall walnut walrus want warm wash wasp
waste water wave way wealth wear weasel web west wet whale wharf what wheat wheel when where whip whisk wide
width wild will willow win window wine wing wink winner winter wire wisdom wise wish wolf wombat wonder wood
wool word work world worry worth wrap wreck wren wrist write wrong yak yard yarn year yellow yeti yodel you
young youth yucca zebra zenith zero zinnia zither zone zoo
`;

export const PASSPHRASE_WORDS: readonly string[] = WORDS.trim().split(/\s+/);
