'use strict';

const { getPluginService } = require('../utils/functions');
const { checkForExistingId } = require('./utils/functions')
const { REGEX } = require('../utils/constants');
const PluginError = require('./../utils/error');
const { verifyRecaptcha } = require('./../utils/verifyRecaptcha');
const crypto = require('crypto');
module.exports = ({ strapi }) => ({
  pluginService (name = 'common') {
    return getPluginService(name)
  },
  fetchContentTypes() {
    const contentTypes = strapi.contentTypes
    const keys = Object.keys(contentTypes);
    let collectionTypes = [];
    let singleTypes = [];

    keys.forEach((name) => {
      if (name.includes('api::')) {
        const object = {
          uid: contentTypes[name].uid,
          kind: contentTypes[name].kind,
          globalId: contentTypes[name].globalId,
          attributes: contentTypes[name].attributes,
        };
        contentTypes[name].kind === 'collectionType'
          ? collectionTypes.push(object)
          : singleTypes.push(object);
      }
    });

    return { collectionTypes, singleTypes } || null;
  },

  async getCollection(contentType) {
    const entries = await strapi.entityService.findMany(contentType, { populate: '*' })
    return entries
  },
  async createVotelog (payload) {
    try {
      let date = new Date()
      date.setDate(date.getDate()+1);
      date.setHours(0);
      date.setMinutes(0);
      date.setSeconds(0);
      const votelog = await strapi.entityService.create('plugin::voting.votelog', {
        data: {
          ...payload,
          publishedAt: new Date(),
          expiresAt: date
        },
      });
      if (votelog) {
        return votelog
      }
    } catch (e) {
      throw new PluginError(400, e.message);
    }
  },
  async findUser (userUid) {
    console.log('[VOTING] Looking for user with uid:', userUid)
    try {
      const user = await strapi.entityService.findMany('plugin::voting.vote', {
        filters: { userUid },
        populate: ['votes']
      });
      if (user) {
        console.log('[VOTING] User found..', user)
        return user[0]
      }
    } catch (e) {
      throw new PluginError(400, e.message);
    }
  },

  /** Update a user's votes */
  async updateUser (votes, id) {
    try {
      const finalVote = await strapi.entityService.update('plugin::voting.vote', id, {
        data: {
          votes
        },
      });
      if (finalVote) {
        return finalVote
      }
    } catch (e) {
      throw new PluginError(400, e.message);
    }
  },

  /* Create a new user, throw if there is a collision */
  async createNewUser (userUid) {
    try {
      const newUser = await strapi.entityService.create('plugin::voting.vote', {
        data: {
          userUid,
          votes: []
        },
      });
      if (newUser) {
        return newUser
      }
    } catch (e) {
      throw new PluginError(400, e.message);
    }
  },
  async doVoting (uid, id, votes) {
    try {
      const entryUpdated = await strapi.entityService.update(uid, id, {
        data: {
          votes
        }
      });
      if (entryUpdated) {
        return entryUpdated
      }
    } catch (e) {
      throw new PluginError(400, e.message);
    }
  },

  /* Vote on behalf of an user */
  async vote(relation, data) {
    const [ uid, relatedId ] = await this.pluginService().parseRelationString(relation);

    if (!data.userUid) throw new Error("Must pass a userUid in the request body.");

    // Check for correct collection relation string in req
    const singleRelationFulfilled = relation && REGEX.relatedUid.test(relation);
    if (!singleRelationFulfilled) {
      throw new PluginError(400, `Field "related" got incorrect format, use format like "api::<collection name>.<content type name>:<entity id>"`);
    }
    // Parse collection relation string
    // const [ uid, relatedId ] = await this.pluginService().parseRelationString(relation);
    // Find related entity by relation string
    const relatedEntity = await strapi.entityService.findOne(uid, relatedId, { fields: ['votes'] });
    if (!relatedEntity) {
      throw new PluginError(400, `Relation for field "related" does not exist. Check your payload please.`);
    }
    // If relation correct and entity found...
    if (singleRelationFulfilled && relatedEntity) {
      try {
        // Try to find user
        const votingUser = await this.findUser(userUid)
        if (votingUser) {
          // Check for ids
          const votedBefore = checkForExistingId(votingUser.votes, relation)
          if (votedBefore) {
            throw new PluginError(403, `Already voted for ${relation}`);
          } else {
            const votes = await relatedEntity.votes + 1
            const voted = await this.doVoting(uid, relatedEntity.id, votes)
            if (voted) {
              // console.log('[VOTING] Voted successfuly', JSON.stringify(voted))
              const payload = {
                userUid,
                related: relation,
                user: votingUser.id,
                voteId: String(relatedId),
                votedAt: new Date()
              }
              const voteLog = await this.createVotelog(payload)
              if (voteLog) {
                const updatedVotes = votingUser.votes && votingUser.votes.length > 0 ? [...votingUser.votes, voteLog.id] : [voteLog.id]
                const updatedUser = await this.updateUser(updatedVotes, votingUser.id)
                if (updatedUser && voted) {
                  // console.log('[VOTING] Voting finished successfuly', JSON.stringify(updatedUser))
                  return voted
                } else {
                  console.log('[VOTING] Voting did not successfuly finished, error updating user')
                }
              } else {
                console.log('[VOTING] VoteLog creation failed, aborting..')
              }
            } else {
              console.log('[VOTING] Voting failed, aborting..')
            }
          }
          return { test: 'test' }
        } else {
          // console.log('[VOTING] User not found, creating one..')
          const votingUserNew = await this.createNewUser(userUid)
          if (votingUserNew) {
            // console.log('[VOTING] New user created:', votingUserNew)
            const votes = await relatedEntity.votes + 1
            const voted = await this.doVoting(uid, relatedEntity.id, votes)
            if (voted) {
              // console.log('[VOTING] Voted successfuly', JSON.stringify(voted))
              const payload = {
                userUid,
                related: relation,
                user: votingUserNew.id,
                voteId: String(relatedId),
                votedAt: new Date()
              }
              const voteLog = await this.createVotelog(payload)
              if (voteLog) {
                const updatedVotes = votingUserNew.votes && votingUserNew.votes.length > 0 ? [...votingUserNew.votes, voteLog.id] : [voteLog.id]
                const updatedUser = await this.updateUser(updatedVotes, votingUserNew.id)
                if (updatedUser && voted) {
                  console.log('[VOTING] Voting finished successfuly')
                  return voted
                } else {
                  console.log('[VOTING] Voting did not successfuly finished, error updating user')
                }
              } else {
                console.log('[VOTING] VoteLog creation failed, aborting..')
              }
            } else {
              console.log('[VOTING] Voting failed, aborting..')
            }
          } else {
            console.log('[VOTING] New user creation failed, aborting..')
          }
        }
      } catch (e) {
        throw new PluginError(400, e.message);
      }
      throw new PluginError(400, 'No content received');
    }
  }
});