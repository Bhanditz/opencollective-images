import fetch from 'node-fetch';
import sizeOf from 'image-size';
import request from 'request';
import graphicsMagick from 'gm';
import LRUCache from 'lru-cache';

import { logger } from '../logger';
import { queryString, getCloudinaryUrl } from '../lib/utils';

import { fetchCollectiveImage, fetchMembersStats, fetchMembers } from '../lib/graphql';

import { svg2png, generateSVGBannerForUsers, generateAsciiFromImage } from '../lib/image-generator';

// Cache the list of members of a collective to avoid requesting it for every single /:collectiveSlug/backers/:position/avatar
const cache = new LRUCache({
  max: 5000,
  maxAge: 1000 * 60 * 10,
});

const imagesUrl = process.env.IMAGES_URL || 'https://images.opencollective.com';

const fetchText = path => fetch(path).then(response => response.text());

/**
 * Generates a github badge for a backerType (backers|sponsors) or for a tierSlug
 */
export async function badge(req, res) {
  try {
    const { style, label } = req.query;
    const color = req.query.color || 'brightgreen';

    let imageUrl;
    try {
      const stats = await fetchMembersStats(req.params);
      const filename = `${label || stats.name}-${stats.count ? stats.count : 0}-${color}.svg`;
      imageUrl = `https://img.shields.io/badge/${filename}?style=${style}`;
    } catch (e) {
      return res.status(404).send('Not found');
    }

    try {
      const imageRequest = await fetchText(imageUrl);
      res.setHeader('content-type', 'image/svg+xml;charset=utf-8');
      res.setHeader('cache-control', 'max-age=600');
      return res.send(imageRequest);
    } catch (e) {
      logger.error('>>> collectives.badge: Error while fetching %s', imageUrl, e);
      res.setHeader('cache-control', 'max-age=30');
      return res.status(500).send(`Unable to fetch ${imageUrl}`);
    }
  } catch (e) {
    logger.debug('>>> collectives.badge error', e);
    return res.status(500).send(`Unable to generate badge for ${req.params.collectiveSlug}/${req.params.backerType}`);
  }
}

export async function logo(req, res, next) {
  // Keeping the resulting image for 60 days in the CDN cache (we purge that cache on deploy)
  res.setHeader('Cache-Control', `public, max-age=${60 * 24 * 60 * 60}`);

  let collective;
  try {
    collective = await fetchCollectiveImage(req.params.collectiveSlug);
    if (!collective.image) {
      return res.status(404).send('Not found (No collective image)');
    }
  } catch (e) {
    if (e.message.match(/No collective found/)) {
      return res.status(404).send('Not found');
    }
    logger.debug('>>> collectives.logo error', e);
    return next(e);
  }
  const imagesrc = collective.image;

  const params = {};
  const { width, height } = req.query;
  if (Number(width)) {
    params['width'] = Number(width);
  }
  if (Number(height)) {
    params['height'] = Number(height);
  }

  switch (req.params.format) {
    case 'txt':
      generateAsciiFromImage(imagesrc, {
        bg: req.query.bg === 'true' ? true : false,
        fg: req.query.fg === 'true' ? true : false,
        white_bg: req.query.white_bg === 'false' ? false : true,
        colored: req.query.colored === 'false' ? false : true,
        size: {
          height: params.height || 20,
          width: params.width,
        },
        variant: req.query.variant || 'wide',
        trim: req.query.trim !== 'false',
        reverse: req.query.reverse === 'true' ? true : false,
      })
        .then(ascii => {
          res.setHeader('content-type', 'text/plain; charset=us-ascii');
          res.send(`${ascii}\n`);
        })
        .catch(() => {
          return next(new Error(`Unable to create an ASCII art for ${imagesrc}`));
        });
      break;

    default:
      graphicsMagick(request(imagesrc))
        .resize(params.width, params.height)
        .stream(req.params.format)
        .pipe(res);
      break;
  }
}

export async function background(req, res, next) {
  // Keeping the resulting image for 60 days in the CDN cache (we purge that cache on deploy)
  res.setHeader('Cache-Control', `public, max-age=${60 * 24 * 60 * 60}`);

  let collective;
  try {
    collective = await fetchCollectiveImage(req.params.collectiveSlug);
    if (!collective.backgroundImage) {
      return res.status(404).send('Not found (No collective backgroundImage)');
    }
  } catch (e) {
    if (e.message.match(/No collective found/)) {
      return res.status(404).send('Not found');
    }
    logger.debug('>>> collectives.background error', e);
    return next(e);
  }

  const params = {};
  const { width, height } = req.query;
  if (Number(width)) {
    params['width'] = Number(width);
  }
  if (Number(height)) {
    params['height'] = Number(height);
  }

  graphicsMagick(request(collective.backgroundImage))
    .resize(params.width, params.height)
    .stream(req.params.format)
    .pipe(res);
}

export async function banner(req, res) {
  const { collectiveSlug, tierSlug, backerType } = req.params;
  const format = req.params.format || 'svg';
  const style = req.query.style || 'rounded';
  const limit = Number(req.query.limit) || Infinity;
  const width = Number(req.query.width) || 0;
  const height = Number(req.query.height) || 0;
  const { avatarHeight, margin } = req.query;
  const showBtn = req.query.button === 'false' ? false : true;

  let users = cache.get(queryString.stringify(req.params));
  if (!users) {
    try {
      users = await fetchMembers(req.params);
      cache.set(queryString.stringify(req.params), users);
    } catch (e) {
      logger.error('>>> collectives.banner: Error while fetching members', e);
      return res.status(404).send('Not found');
    }
  }

  const selector = tierSlug || backerType;
  const linkToProfile = selector === 'contributors' || selector == 'sponsors' ? false : true;
  const buttonImage =
    showBtn && `${imagesUrl}/static/images/become_${selector.match(/sponsor/) ? 'sponsor' : 'backer'}.svg`;
  return generateSVGBannerForUsers(users, {
    format,
    style,
    limit,
    buttonImage,
    width,
    height,
    avatarHeight,
    margin,
    linkToProfile,
    collectiveSlug,
  })
    .then(svg => {
      switch (format) {
        case 'svg':
          res.setHeader('content-type', 'image/svg+xml;charset=utf-8');
          return svg;

        case 'png':
          res.setHeader('content-type', 'image/png');
          return svg2png(svg);
      }
    })
    .then(content => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(content);
    })
    .catch(e => {
      logger.error('>>> collectives.banner error', e);
    });
}

export async function avatar(req, res) {
  req.params.isActive = req.query.isActive === 'false' ? false : true;
  const { collectiveSlug, tierSlug, backerType, isActive } = req.params;
  let users = cache.get(queryString.stringify({ collectiveSlug, tierSlug, backerType, isActive }));
  if (!users) {
    try {
      users = await fetchMembers(req.params);
      cache.set(
        queryString.stringify({
          collectiveSlug,
          tierSlug,
          backerType,
          isActive,
        }),
        users,
      );
    } catch (e) {
      return res.status(404).send('Not found');
    }
  }

  const position = parseInt(req.params.position, 10);
  const user = position < users.length ? users[position] : {};

  const format = req.params.format || 'svg';
  let maxHeight, maxWidth;
  const selector = tierSlug || backerType;
  if (req.query.avatarHeight) {
    maxHeight = Number(req.query.avatarHeight);
  } else {
    maxHeight = format === 'svg' ? 128 : 64;
    if (selector.match(/silver/)) maxHeight *= 1.25;
    if (selector.match(/gold/)) maxHeight *= 1.5;
    if (selector.match(/diamond/)) maxHeight *= 2;
    maxWidth = maxHeight * 3;
  }

  const collectiveType = user.type === 'USER' ? 'user' : 'organization';
  let imageUrl = `/static/images/${collectiveType}.svg`;
  if (user.image && user.image.substr(0, 1) !== '/') {
    if (user.type === 'USER') {
      imageUrl = getCloudinaryUrl(user.image, {
        query: `/c_thumb,g_face,h_${maxHeight},r_max,w_${maxHeight},bo_3px_solid_white/c_thumb,h_${maxHeight},r_max,w_${maxHeight},bo_2px_solid_rgb:66C71A/e_trim/f_auto/`,
      });
    } else {
      imageUrl = getCloudinaryUrl(user.image, {
        height: maxHeight,
        width: maxWidth,
      });
    }
  }

  if (position == users.length) {
    const btnImage = selector.match(/sponsor/) ? 'sponsor' : 'backer';
    imageUrl = `/static/images/become_${btnImage}.svg`;
  } else if (position > users.length) {
    imageUrl = '/static/images/1px.png';
  }

  if (imageUrl.substr(0, 1) === '/') {
    return res.redirect(imageUrl);
  }

  if (format === 'svg') {
    request({ url: imageUrl, encoding: null }, (err, r, data) => {
      if (err) {
        return res.status(500).send(`Unable to fetch ${imageUrl}`);
      }
      const contentType = r.headers['content-type'];

      const imageHeight = Math.round(maxHeight / 2);
      let imageWidth = 64;
      if (selector.match(/sponsor/)) {
        try {
          const dimensions = sizeOf(data);
          imageWidth = Math.round((dimensions.width / dimensions.height) * imageHeight);
        } catch (e) {
          logger.error('>>> collectives.avatar: Unable to get image dimensions for %s', imageUrl, e);
          return res.status(500).send(`Unable to fetch ${imageUrl}`);
        }
      }

      const base64data = Buffer.from(data).toString('base64');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${imageWidth}" height="${imageHeight}">
        <image width="${imageWidth}" height="${imageHeight}" xlink:href="data:${contentType};base64,${base64data}"/>
      </svg>`;
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('content-type', 'image/svg+xml;charset=utf-8');
      return res.send(svg);
    });
  } else {
    req
      .pipe(request(imageUrl))
      .on('error', e => {
        logger.error('>>> collectives.avatar: Error proxying %s', imageUrl, e);
        res.status(500).send(e);
      })
      .on('response', res => {
        res.headers['Cache-Control'] = 'public, max-age=300';
      })
      .pipe(res);
  }
}
