/**
 * @module page-builder/section-registry
 *
 * Defines all built-in section types for the Gbox page builder.
 * Each section includes a Shopify-compatible settings schema that drives
 * the admin editor UI and validates storefront data.
 */

// ---------------------------------------------------------------------------
// Setting Types
// ---------------------------------------------------------------------------

/** All supported setting input types (Shopify-compatible). */
export type SettingType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'image'
  | 'url'
  | 'color'
  | 'range'
  | 'select'
  | 'checkbox'
  | 'number'
  | 'video_url'
  | 'collection'
  | 'product'
  | 'page'
  | 'menu'
  | 'font'
  | 'html'
  | 'header'
  | 'paragraph';

/**
 * Describes a single setting field inside a section or block.
 *
 * The shape intentionally mirrors Shopify's `{% schema %}` setting objects so
 * themes authored for Shopify can be ported with minimal changes.
 */
export interface SettingDefinition {
  /** Unique key within the section/block. */
  id: string;
  /** Input type rendered in the admin editor. */
  type: SettingType;
  /** Human-readable label shown in the editor. */
  label: string;
  /** Default value used when the merchant has not customised the setting. */
  default?: any;
  /** Help text displayed below the input. */
  info?: string;
  /** Placeholder text for text-style inputs. */
  placeholder?: string;

  // --- range-specific ---
  /** Minimum value (range inputs). */
  min?: number;
  /** Maximum value (range inputs). */
  max?: number;
  /** Step increment (range inputs). */
  step?: number;
  /** Unit label shown next to range value (e.g. "px", "%"). */
  unit?: string;

  // --- select-specific ---
  /** Options for select/dropdown inputs. */
  options?: Array<{ value: string; label: string }>;
}

/**
 * A repeatable block that merchants can add inside a section (e.g. slides
 * within a slideshow, columns within a multi-column layout).
 */
export interface BlockDefinition {
  /** Machine-readable block type key (e.g. "slide"). */
  type: string;
  /** Human-readable name shown in the editor. */
  name: string;
  /** Maximum number of instances allowed. */
  limit?: number;
  /** Settings exposed for each block instance. */
  settings: SettingDefinition[];
}

/**
 * Full schema for a section type.
 *
 * Sections are the top-level building blocks of a page layout. Each schema
 * describes the settings panel rendered in the page-builder admin, the
 * repeatable blocks it supports, and optional presets for quick insertion.
 */
export interface SectionSchema {
  /** Human-readable display name. */
  name: string;
  /** Unique machine-readable type key (kebab-case). */
  type: string;
  /** Short description shown in the section picker. */
  description: string;
  /** Category used for grouping in the section picker. */
  category: 'header' | 'content' | 'footer' | 'product' | 'marketing' | 'media' | 'text';
  /** Icon identifier for the section picker UI. */
  icon: string;
  /** Top-level settings for this section. */
  settings: SettingDefinition[];
  /** Repeatable block definitions (if any). */
  blocks?: BlockDefinition[];
  /** Maximum total blocks allowed across all block types. */
  maxBlocks?: number;
  /** Presets provide one-click starter configurations. */
  presets?: Array<{
    name: string;
    settings?: Record<string, any>;
    blocks?: Array<{ type: string; settings?: Record<string, any> }>;
  }>;
}

// ---------------------------------------------------------------------------
// Built-in Sections
// ---------------------------------------------------------------------------

const announcementBar: SectionSchema = {
  name: 'Announcement Bar',
  type: 'announcement-bar',
  description: 'A dismissible bar for promotions, alerts, or important messages.',
  category: 'header',
  icon: 'megaphone',
  settings: [
    {
      id: 'text',
      type: 'text',
      label: 'Announcement text',
      default: 'Welcome to our store!',
      placeholder: 'Enter your announcement...',
    },
    {
      id: 'link',
      type: 'url',
      label: 'Link',
      info: 'Optional URL the announcement links to.',
    },
    {
      id: 'bg_color',
      type: 'color',
      label: 'Background color',
      default: '#1a1a1a',
    },
    {
      id: 'text_color',
      type: 'color',
      label: 'Text color',
      default: '#ffffff',
    },
    {
      id: 'show_close_button',
      type: 'checkbox',
      label: 'Show close button',
      default: true,
      info: 'Allow visitors to dismiss the announcement.',
    },
  ],
  presets: [
    {
      name: 'Announcement Bar',
      settings: {
        text: 'Free shipping on orders over $50!',
        bg_color: '#1a1a1a',
        text_color: '#ffffff',
        show_close_button: true,
      },
    },
  ],
};

const header: SectionSchema = {
  name: 'Header',
  type: 'header',
  description: 'Site header with logo, navigation, search, and cart.',
  category: 'header',
  icon: 'layout-navbar',
  settings: [
    {
      id: 'logo',
      type: 'image',
      label: 'Logo image',
      info: 'Recommended: SVG or transparent PNG.',
    },
    {
      id: 'logo_width',
      type: 'range',
      label: 'Logo width',
      default: 120,
      min: 50,
      max: 300,
      step: 10,
      unit: 'px',
    },
    {
      id: 'menu',
      type: 'menu',
      label: 'Navigation menu',
      default: 'main-menu',
    },
    {
      id: 'sticky',
      type: 'checkbox',
      label: 'Sticky header',
      default: true,
      info: 'Keep the header visible when scrolling.',
    },
    {
      id: 'show_search',
      type: 'checkbox',
      label: 'Show search',
      default: true,
    },
    {
      id: 'show_cart',
      type: 'checkbox',
      label: 'Show cart icon',
      default: true,
    },
    {
      id: 'bg_color',
      type: 'color',
      label: 'Background color',
      default: '#ffffff',
    },
    {
      id: 'text_color',
      type: 'color',
      label: 'Text color',
      default: '#1a1a1a',
    },
    {
      id: 'border_color',
      type: 'color',
      label: 'Border color',
      default: '#e5e5e5',
      info: 'Color of the bottom border.',
    },
  ],
  presets: [
    {
      name: 'Header',
      settings: {
        logo_width: 120,
        sticky: true,
        show_search: true,
        show_cart: true,
        bg_color: '#ffffff',
        text_color: '#1a1a1a',
        border_color: '#e5e5e5',
      },
    },
  ],
};

const heroBanner: SectionSchema = {
  name: 'Hero Banner',
  type: 'hero-banner',
  description: 'Full-width hero image with heading, subheading, and call-to-action buttons.',
  category: 'content',
  icon: 'photo',
  settings: [
    { id: 'image', type: 'image', label: 'Background image' },
    {
      id: 'mobile_image',
      type: 'image',
      label: 'Mobile image',
      info: 'Optional image optimised for mobile viewports.',
    },
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Welcome to our store',
    },
    {
      id: 'subheading',
      type: 'text',
      label: 'Subheading',
      default: 'Discover our latest collection',
    },
    {
      id: 'button_text',
      type: 'text',
      label: 'Button text',
      default: 'Shop now',
    },
    { id: 'button_url', type: 'url', label: 'Button link' },
    {
      id: 'text_color',
      type: 'color',
      label: 'Text color',
      default: '#ffffff',
    },
    {
      id: 'overlay_opacity',
      type: 'range',
      label: 'Overlay opacity',
      default: 40,
      min: 0,
      max: 100,
      step: 5,
      unit: '%',
      info: 'Darken the background image to improve text readability.',
    },
    {
      id: 'text_alignment',
      type: 'select',
      label: 'Text alignment',
      default: 'center',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      id: 'min_height',
      type: 'range',
      label: 'Minimum height',
      default: 600,
      min: 300,
      max: 900,
      step: 50,
      unit: 'px',
    },
  ],
  blocks: [
    {
      type: 'button',
      name: 'Button',
      limit: 3,
      settings: [
        { id: 'text', type: 'text', label: 'Button text', default: 'Shop now' },
        { id: 'url', type: 'url', label: 'Button link' },
        {
          id: 'style',
          type: 'select',
          label: 'Button style',
          default: 'primary',
          options: [
            { value: 'primary', label: 'Primary' },
            { value: 'secondary', label: 'Secondary' },
            { value: 'outline', label: 'Outline' },
          ],
        },
      ],
    },
  ],
  maxBlocks: 3,
  presets: [
    {
      name: 'Hero Banner',
      settings: {
        heading: 'Welcome to our store',
        subheading: 'Discover our latest collection',
        button_text: 'Shop now',
        text_color: '#ffffff',
        overlay_opacity: 40,
        text_alignment: 'center',
        min_height: 600,
      },
      blocks: [
        { type: 'button', settings: { text: 'Shop now', style: 'primary' } },
      ],
    },
  ],
};

const featuredCollection: SectionSchema = {
  name: 'Featured Collection',
  type: 'featured-collection',
  description: 'Display products from a specific collection in a grid.',
  category: 'product',
  icon: 'layout-grid',
  settings: [
    {
      id: 'title',
      type: 'text',
      label: 'Heading',
      default: 'Featured Collection',
    },
    {
      id: 'collection',
      type: 'collection',
      label: 'Collection',
      info: 'Choose a collection to feature.',
    },
    {
      id: 'products_count',
      type: 'range',
      label: 'Products to show',
      default: 8,
      min: 4,
      max: 20,
      step: 1,
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '4',
      options: [
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns' },
        { value: '4', label: '4 columns' },
        { value: '5', label: '5 columns' },
      ],
    },
    {
      id: 'show_view_all',
      type: 'checkbox',
      label: 'Show "View all" link',
      default: true,
    },
    {
      id: 'card_style',
      type: 'select',
      label: 'Card style',
      default: 'standard',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'minimal', label: 'Minimal' },
        { value: 'overlay', label: 'Overlay' },
      ],
    },
  ],
  presets: [
    {
      name: 'Featured Collection',
      settings: {
        title: 'Featured Collection',
        products_count: 8,
        columns: '4',
        show_view_all: true,
        card_style: 'standard',
      },
    },
  ],
};

const featuredProducts: SectionSchema = {
  name: 'Featured Products',
  type: 'featured-products',
  description: 'Hand-pick individual products to showcase.',
  category: 'product',
  icon: 'star',
  settings: [
    {
      id: 'title',
      type: 'text',
      label: 'Heading',
      default: 'Featured Products',
    },
    {
      id: 'subtitle',
      type: 'text',
      label: 'Subtitle',
      placeholder: 'Optional subtitle text',
    },
    {
      id: 'products',
      type: 'product',
      label: 'Products',
      info: 'Select up to 8 products.',
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '4',
      options: [
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns' },
        { value: '4', label: '4 columns' },
      ],
    },
    {
      id: 'show_price',
      type: 'checkbox',
      label: 'Show price',
      default: true,
    },
    {
      id: 'show_vendor',
      type: 'checkbox',
      label: 'Show vendor',
      default: false,
    },
  ],
  presets: [
    {
      name: 'Featured Products',
      settings: {
        title: 'Featured Products',
        columns: '4',
        show_price: true,
        show_vendor: false,
      },
    },
  ],
};

const imageWithText: SectionSchema = {
  name: 'Image with Text',
  type: 'image-with-text',
  description: 'Side-by-side image and rich text content.',
  category: 'content',
  icon: 'layout-sidebar',
  settings: [
    { id: 'image', type: 'image', label: 'Image' },
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Image with text',
    },
    {
      id: 'text',
      type: 'richtext',
      label: 'Content',
      default: '<p>Pair text with an image to focus on your chosen product, collection, or blog post.</p>',
    },
    {
      id: 'button_text',
      type: 'text',
      label: 'Button text',
      placeholder: 'e.g. Learn more',
    },
    { id: 'button_url', type: 'url', label: 'Button link' },
    {
      id: 'layout',
      type: 'select',
      label: 'Layout',
      default: 'image-left',
      options: [
        { value: 'image-left', label: 'Image left' },
        { value: 'image-right', label: 'Image right' },
      ],
    },
    {
      id: 'image_width',
      type: 'select',
      label: 'Image width',
      default: 'medium',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
      ],
    },
    {
      id: 'text_alignment',
      type: 'select',
      label: 'Text alignment',
      default: 'left',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
      ],
    },
  ],
  presets: [
    {
      name: 'Image with Text',
      settings: {
        heading: 'Image with text',
        layout: 'image-left',
        image_width: 'medium',
        text_alignment: 'left',
      },
    },
  ],
};

const richText: SectionSchema = {
  name: 'Rich Text',
  type: 'rich-text',
  description: 'A full-width rich text content area.',
  category: 'text',
  icon: 'align-left',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      placeholder: 'Optional heading',
    },
    {
      id: 'content',
      type: 'richtext',
      label: 'Content',
      default: '<p>Use this section for any descriptive text you need to share with your customers.</p>',
    },
    {
      id: 'text_alignment',
      type: 'select',
      label: 'Text alignment',
      default: 'center',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      id: 'max_width',
      type: 'select',
      label: 'Content width',
      default: 'medium',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
        { value: 'full', label: 'Full width' },
      ],
    },
  ],
  presets: [
    {
      name: 'Rich Text',
      settings: {
        text_alignment: 'center',
        max_width: 'medium',
      },
    },
  ],
};

const imageBanner: SectionSchema = {
  name: 'Image Banner',
  type: 'image-banner',
  description: 'Full-width banner image with text overlay and flexible positioning.',
  category: 'media',
  icon: 'photo',
  settings: [
    { id: 'image', type: 'image', label: 'Banner image' },
    {
      id: 'mobile_image',
      type: 'image',
      label: 'Mobile image',
      info: 'Optional image for mobile viewports.',
    },
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Image Banner',
    },
    {
      id: 'subheading',
      type: 'text',
      label: 'Subheading',
      placeholder: 'Optional subheading',
    },
    {
      id: 'button_text',
      type: 'text',
      label: 'Button text',
      placeholder: 'e.g. Shop now',
    },
    { id: 'button_url', type: 'url', label: 'Button link' },
    {
      id: 'text_position',
      type: 'select',
      label: 'Text position',
      default: 'center',
      options: [
        { value: 'top-left', label: 'Top left' },
        { value: 'top-center', label: 'Top center' },
        { value: 'top-right', label: 'Top right' },
        { value: 'center-left', label: 'Center left' },
        { value: 'center', label: 'Center' },
        { value: 'center-right', label: 'Center right' },
        { value: 'bottom-left', label: 'Bottom left' },
        { value: 'bottom-center', label: 'Bottom center' },
        { value: 'bottom-right', label: 'Bottom right' },
      ],
    },
    {
      id: 'overlay_opacity',
      type: 'range',
      label: 'Overlay opacity',
      default: 30,
      min: 0,
      max: 100,
      step: 5,
      unit: '%',
    },
  ],
  presets: [
    {
      name: 'Image Banner',
      settings: {
        heading: 'Image Banner',
        text_position: 'center',
        overlay_opacity: 30,
      },
    },
  ],
};

const slideshow: SectionSchema = {
  name: 'Slideshow',
  type: 'slideshow',
  description: 'Rotating carousel of full-width slides with optional autoplay.',
  category: 'media',
  icon: 'slideshow',
  settings: [
    {
      id: 'autoplay',
      type: 'checkbox',
      label: 'Autoplay',
      default: true,
    },
    {
      id: 'autoplay_speed',
      type: 'range',
      label: 'Autoplay speed',
      default: 5,
      min: 3,
      max: 10,
      step: 1,
      unit: 's',
      info: 'Seconds between slide transitions.',
    },
    {
      id: 'show_arrows',
      type: 'checkbox',
      label: 'Show navigation arrows',
      default: true,
    },
    {
      id: 'show_dots',
      type: 'checkbox',
      label: 'Show pagination dots',
      default: true,
    },
    {
      id: 'min_height',
      type: 'range',
      label: 'Minimum height',
      default: 600,
      min: 300,
      max: 900,
      step: 50,
      unit: 'px',
    },
  ],
  blocks: [
    {
      type: 'slide',
      name: 'Slide',
      settings: [
        { id: 'image', type: 'image', label: 'Image' },
        { id: 'heading', type: 'text', label: 'Heading', placeholder: 'Slide heading' },
        { id: 'subheading', type: 'text', label: 'Subheading', placeholder: 'Slide subheading' },
        { id: 'button_text', type: 'text', label: 'Button text', placeholder: 'e.g. Shop now' },
        { id: 'button_url', type: 'url', label: 'Button link' },
        { id: 'text_color', type: 'color', label: 'Text color', default: '#ffffff' },
        {
          id: 'overlay_opacity',
          type: 'range',
          label: 'Overlay opacity',
          default: 40,
          min: 0,
          max: 100,
          step: 5,
          unit: '%',
        },
      ],
    },
  ],
  maxBlocks: 10,
  presets: [
    {
      name: 'Slideshow',
      settings: {
        autoplay: true,
        autoplay_speed: 5,
        show_arrows: true,
        show_dots: true,
        min_height: 600,
      },
      blocks: [
        { type: 'slide', settings: { heading: 'Slide 1', text_color: '#ffffff', overlay_opacity: 40 } },
        { type: 'slide', settings: { heading: 'Slide 2', text_color: '#ffffff', overlay_opacity: 40 } },
      ],
    },
  ],
};

const collectionList: SectionSchema = {
  name: 'Collection List',
  type: 'collection-list',
  description: 'Grid of featured collections with images and titles.',
  category: 'product',
  icon: 'folders',
  settings: [
    {
      id: 'title',
      type: 'text',
      label: 'Heading',
      default: 'Collections',
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '3',
      options: [
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns' },
        { value: '4', label: '4 columns' },
      ],
    },
    {
      id: 'show_title',
      type: 'checkbox',
      label: 'Show collection title',
      default: true,
    },
    {
      id: 'show_count',
      type: 'checkbox',
      label: 'Show product count',
      default: false,
    },
  ],
  blocks: [
    {
      type: 'collection',
      name: 'Collection',
      settings: [
        {
          id: 'collection',
          type: 'collection',
          label: 'Collection',
        },
      ],
    },
  ],
  maxBlocks: 12,
  presets: [
    {
      name: 'Collection List',
      settings: {
        title: 'Collections',
        columns: '3',
        show_title: true,
        show_count: false,
      },
      blocks: [
        { type: 'collection' },
        { type: 'collection' },
        { type: 'collection' },
      ],
    },
  ],
};

const newsletter: SectionSchema = {
  name: 'Newsletter',
  type: 'newsletter',
  description: 'Email newsletter signup form.',
  category: 'marketing',
  icon: 'mail',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Subscribe to our newsletter',
    },
    {
      id: 'subheading',
      type: 'text',
      label: 'Subheading',
      default: 'Be the first to know about new collections and exclusive offers.',
    },
    {
      id: 'button_text',
      type: 'text',
      label: 'Button text',
      default: 'Subscribe',
    },
    {
      id: 'bg_color',
      type: 'color',
      label: 'Background color',
      default: '#f5f5f5',
    },
    {
      id: 'text_color',
      type: 'color',
      label: 'Text color',
      default: '#1a1a1a',
    },
    {
      id: 'show_social',
      type: 'checkbox',
      label: 'Show social media links',
      default: true,
    },
  ],
  presets: [
    {
      name: 'Newsletter',
      settings: {
        heading: 'Subscribe to our newsletter',
        subheading: 'Be the first to know about new collections and exclusive offers.',
        button_text: 'Subscribe',
        bg_color: '#f5f5f5',
        text_color: '#1a1a1a',
        show_social: true,
      },
    },
  ],
};

const testimonials: SectionSchema = {
  name: 'Testimonials',
  type: 'testimonials',
  description: 'Customer testimonials with quotes, names, and photos.',
  category: 'marketing',
  icon: 'quote',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'What our customers say',
    },
    {
      id: 'bg_color',
      type: 'color',
      label: 'Background color',
      default: '#ffffff',
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '3',
      options: [
        { value: '1', label: '1 column' },
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns' },
      ],
    },
  ],
  blocks: [
    {
      type: 'testimonial',
      name: 'Testimonial',
      settings: [
        {
          id: 'quote',
          type: 'textarea',
          label: 'Quote',
          default: 'This is an amazing store with great products!',
        },
        { id: 'author', type: 'text', label: 'Author name', default: 'Happy Customer' },
        { id: 'role', type: 'text', label: 'Role / Title', placeholder: 'e.g. Verified Buyer' },
        { id: 'image', type: 'image', label: 'Author photo' },
      ],
    },
  ],
  maxBlocks: 12,
  presets: [
    {
      name: 'Testimonials',
      settings: {
        heading: 'What our customers say',
        columns: '3',
      },
      blocks: [
        { type: 'testimonial', settings: { quote: 'Amazing quality and fast delivery!', author: 'Jane D.' } },
        { type: 'testimonial', settings: { quote: 'Best online store I have shopped at.', author: 'John S.' } },
        { type: 'testimonial', settings: { quote: 'Excellent customer service!', author: 'Sarah M.' } },
      ],
    },
  ],
};

const video: SectionSchema = {
  name: 'Video',
  type: 'video',
  description: 'Embedded video section with optional heading and cover image.',
  category: 'media',
  icon: 'player-play',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      placeholder: 'Optional heading',
    },
    {
      id: 'video_url',
      type: 'video_url',
      label: 'Video URL',
      info: 'Supports YouTube and Vimeo URLs.',
    },
    {
      id: 'cover_image',
      type: 'image',
      label: 'Cover image',
      info: 'Displayed before the video plays.',
    },
    {
      id: 'autoplay',
      type: 'checkbox',
      label: 'Autoplay',
      default: false,
    },
    {
      id: 'loop',
      type: 'checkbox',
      label: 'Loop video',
      default: false,
    },
  ],
  presets: [
    {
      name: 'Video',
      settings: {
        autoplay: false,
        loop: false,
      },
    },
  ],
};

const logoList: SectionSchema = {
  name: 'Logo List',
  type: 'logo-list',
  description: 'Row of brand or partner logos.',
  category: 'marketing',
  icon: 'badges',
  settings: [
    {
      id: 'title',
      type: 'text',
      label: 'Heading',
      default: 'Our Partners',
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '5',
      options: [
        { value: '4', label: '4 columns' },
        { value: '5', label: '5 columns' },
        { value: '6', label: '6 columns' },
      ],
    },
  ],
  blocks: [
    {
      type: 'logo',
      name: 'Logo',
      settings: [
        { id: 'image', type: 'image', label: 'Logo image' },
        { id: 'link', type: 'url', label: 'Link', info: 'Optional URL when logo is clicked.' },
      ],
    },
  ],
  maxBlocks: 12,
  presets: [
    {
      name: 'Logo List',
      settings: {
        title: 'Our Partners',
        columns: '5',
      },
    },
  ],
};

const multiColumn: SectionSchema = {
  name: 'Multi-column',
  type: 'multi-column',
  description: 'Flexible multi-column layout with images, text, and buttons.',
  category: 'content',
  icon: 'columns',
  settings: [
    {
      id: 'title',
      type: 'text',
      label: 'Heading',
      default: 'Multi-column',
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '3',
      options: [
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns' },
        { value: '4', label: '4 columns' },
      ],
    },
    {
      id: 'text_alignment',
      type: 'select',
      label: 'Text alignment',
      default: 'center',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
  ],
  blocks: [
    {
      type: 'column',
      name: 'Column',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Column heading' },
        {
          id: 'text',
          type: 'richtext',
          label: 'Content',
          default: '<p>Describe a feature, service, or benefit.</p>',
        },
        { id: 'image', type: 'image', label: 'Image' },
        { id: 'button_text', type: 'text', label: 'Button text', placeholder: 'e.g. Learn more' },
        { id: 'button_url', type: 'url', label: 'Button link' },
      ],
    },
  ],
  maxBlocks: 6,
  presets: [
    {
      name: 'Multi-column',
      settings: {
        title: 'Multi-column',
        columns: '3',
        text_alignment: 'center',
      },
      blocks: [
        { type: 'column', settings: { heading: 'Column one' } },
        { type: 'column', settings: { heading: 'Column two' } },
        { type: 'column', settings: { heading: 'Column three' } },
      ],
    },
  ],
};

const productGrid: SectionSchema = {
  name: 'Product Grid',
  type: 'product-grid',
  description: 'Filterable, sortable product grid with pagination.',
  category: 'product',
  icon: 'grid-dots',
  settings: [
    {
      id: 'title',
      type: 'text',
      label: 'Heading',
      default: 'All Products',
    },
    {
      id: 'collection',
      type: 'collection',
      label: 'Collection',
      info: 'Leave empty to show all products.',
    },
    {
      id: 'products_count',
      type: 'range',
      label: 'Products per page',
      default: 12,
      min: 4,
      max: 24,
      step: 4,
    },
    {
      id: 'columns',
      type: 'select',
      label: 'Columns',
      default: '4',
      options: [
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns' },
        { value: '4', label: '4 columns' },
        { value: '5', label: '5 columns' },
      ],
    },
    {
      id: 'show_filters',
      type: 'checkbox',
      label: 'Show filters',
      default: true,
    },
    {
      id: 'show_sort',
      type: 'checkbox',
      label: 'Show sort dropdown',
      default: true,
    },
    {
      id: 'pagination_type',
      type: 'select',
      label: 'Pagination type',
      default: 'numbers',
      options: [
        { value: 'numbers', label: 'Page numbers' },
        { value: 'load-more', label: 'Load more button' },
        { value: 'infinite', label: 'Infinite scroll' },
      ],
    },
  ],
  presets: [
    {
      name: 'Product Grid',
      settings: {
        title: 'All Products',
        products_count: 12,
        columns: '4',
        show_filters: true,
        show_sort: true,
        pagination_type: 'numbers',
      },
    },
  ],
};

const contactForm: SectionSchema = {
  name: 'Contact Form',
  type: 'contact-form',
  description: 'A contact form with configurable fields.',
  category: 'content',
  icon: 'mail',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Contact Us',
    },
    {
      id: 'subheading',
      type: 'text',
      label: 'Subheading',
      placeholder: 'Optional subheading',
    },
    {
      id: 'show_phone',
      type: 'checkbox',
      label: 'Show phone number field',
      default: false,
    },
    {
      id: 'show_subject',
      type: 'checkbox',
      label: 'Show subject field',
      default: true,
    },
    {
      id: 'success_message',
      type: 'text',
      label: 'Success message',
      default: 'Thank you for your message. We will get back to you shortly.',
    },
  ],
  presets: [
    {
      name: 'Contact Form',
      settings: {
        heading: 'Contact Us',
        show_phone: false,
        show_subject: true,
        success_message: 'Thank you for your message. We will get back to you shortly.',
      },
    },
  ],
};

const faq: SectionSchema = {
  name: 'FAQ',
  type: 'faq',
  description: 'Frequently asked questions in accordion or grid layout.',
  category: 'text',
  icon: 'help-circle',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Frequently Asked Questions',
    },
    {
      id: 'subheading',
      type: 'text',
      label: 'Subheading',
      placeholder: 'Optional subheading',
    },
    {
      id: 'layout',
      type: 'select',
      label: 'Layout',
      default: 'accordion',
      options: [
        { value: 'accordion', label: 'Accordion' },
        { value: 'grid', label: 'Grid' },
      ],
    },
  ],
  blocks: [
    {
      type: 'question',
      name: 'Question',
      settings: [
        { id: 'question', type: 'text', label: 'Question', default: 'What is your return policy?' },
        {
          id: 'answer',
          type: 'richtext',
          label: 'Answer',
          default: '<p>We offer a 30-day return policy on all items.</p>',
        },
      ],
    },
  ],
  maxBlocks: 20,
  presets: [
    {
      name: 'FAQ',
      settings: {
        heading: 'Frequently Asked Questions',
        layout: 'accordion',
      },
      blocks: [
        {
          type: 'question',
          settings: {
            question: 'What is your return policy?',
            answer: '<p>We offer a 30-day return policy on all items.</p>',
          },
        },
        {
          type: 'question',
          settings: {
            question: 'How long does shipping take?',
            answer: '<p>Standard shipping takes 5-7 business days.</p>',
          },
        },
        {
          type: 'question',
          settings: {
            question: 'Do you ship internationally?',
            answer: '<p>Yes, we ship to most countries worldwide.</p>',
          },
        },
      ],
    },
  ],
};

const footer: SectionSchema = {
  name: 'Footer',
  type: 'footer',
  description: 'Site footer with navigation columns, newsletter, and social links.',
  category: 'footer',
  icon: 'layout-bottombar',
  settings: [
    {
      id: 'show_newsletter',
      type: 'checkbox',
      label: 'Show newsletter signup',
      default: true,
    },
    {
      id: 'newsletter_heading',
      type: 'text',
      label: 'Newsletter heading',
      default: 'Stay in touch',
    },
    {
      id: 'show_social',
      type: 'checkbox',
      label: 'Show social media icons',
      default: true,
    },
    {
      id: 'show_payment_icons',
      type: 'checkbox',
      label: 'Show payment icons',
      default: true,
    },
    {
      id: 'copyright_text',
      type: 'text',
      label: 'Copyright text',
      default: '© 2026 Your Store. All rights reserved.',
    },
    {
      id: 'bg_color',
      type: 'color',
      label: 'Background color',
      default: '#1a1a1a',
    },
    {
      id: 'text_color',
      type: 'color',
      label: 'Text color',
      default: '#ffffff',
    },
  ],
  blocks: [
    {
      type: 'column',
      name: 'Column',
      limit: 4,
      settings: [
        { id: 'title', type: 'text', label: 'Column title', default: 'Quick links' },
        { id: 'menu', type: 'menu', label: 'Menu' },
      ],
    },
  ],
  maxBlocks: 4,
  presets: [
    {
      name: 'Footer',
      settings: {
        show_newsletter: true,
        newsletter_heading: 'Stay in touch',
        show_social: true,
        show_payment_icons: true,
        bg_color: '#1a1a1a',
        text_color: '#ffffff',
      },
      blocks: [
        { type: 'column', settings: { title: 'Shop' } },
        { type: 'column', settings: { title: 'Company' } },
        { type: 'column', settings: { title: 'Support' } },
      ],
    },
  ],
};

const customHtml: SectionSchema = {
  name: 'Custom HTML',
  type: 'custom-html',
  description: 'Raw HTML and CSS for advanced customisation.',
  category: 'content',
  icon: 'code',
  settings: [
    {
      id: 'html',
      type: 'html',
      label: 'HTML content',
      info: 'Enter any valid HTML. Scripts are sandboxed.',
    },
    {
      id: 'custom_css',
      type: 'textarea',
      label: 'Custom CSS',
      placeholder: '.my-class { color: red; }',
      info: 'CSS scoped to this section.',
    },
  ],
  presets: [
    {
      name: 'Custom HTML',
    },
  ],
};

const separator: SectionSchema = {
  name: 'Separator',
  type: 'separator',
  description: 'Visual divider between sections.',
  category: 'content',
  icon: 'minus',
  settings: [
    {
      id: 'style',
      type: 'select',
      label: 'Style',
      default: 'line',
      options: [
        { value: 'line', label: 'Solid line' },
        { value: 'dotted', label: 'Dotted line' },
        { value: 'space', label: 'Blank space' },
      ],
    },
    {
      id: 'width',
      type: 'select',
      label: 'Width',
      default: 'full',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'full', label: 'Full width' },
      ],
    },
    {
      id: 'color',
      type: 'color',
      label: 'Color',
      default: '#e5e5e5',
    },
    {
      id: 'padding_top',
      type: 'range',
      label: 'Padding top',
      default: 20,
      min: 0,
      max: 100,
      step: 5,
      unit: 'px',
    },
    {
      id: 'padding_bottom',
      type: 'range',
      label: 'Padding bottom',
      default: 20,
      min: 0,
      max: 100,
      step: 5,
      unit: 'px',
    },
  ],
  presets: [
    {
      name: 'Separator',
      settings: {
        style: 'line',
        width: 'full',
        color: '#e5e5e5',
        padding_top: 20,
        padding_bottom: 20,
      },
    },
  ],
};

const map: SectionSchema = {
  name: 'Map',
  type: 'map',
  description: 'Embedded Google Maps section for store locations.',
  category: 'content',
  icon: 'map-pin',
  settings: [
    {
      id: 'heading',
      type: 'text',
      label: 'Heading',
      default: 'Find Us',
    },
    {
      id: 'address',
      type: 'text',
      label: 'Address',
      placeholder: '123 Main Street, City, Country',
      info: 'Used for the map pin and directions link.',
    },
    {
      id: 'api_key',
      type: 'text',
      label: 'Google Maps API key',
      info: 'Required for the interactive map. Get a key from the Google Cloud Console.',
    },
    {
      id: 'zoom',
      type: 'range',
      label: 'Zoom level',
      default: 14,
      min: 1,
      max: 20,
      step: 1,
    },
    {
      id: 'height',
      type: 'range',
      label: 'Map height',
      default: 450,
      min: 200,
      max: 800,
      step: 50,
      unit: 'px',
    },
  ],
  presets: [
    {
      name: 'Map',
      settings: {
        heading: 'Find Us',
        zoom: 14,
        height: 450,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Immutable array of all 22 built-in section schemas.
 *
 * Consumers should treat this as a read-only reference. To extend the
 * registry at runtime (e.g. with merchant-defined sections), copy the
 * array rather than mutating it.
 */
export const BUILTIN_SECTIONS: readonly SectionSchema[] = Object.freeze([
  announcementBar,
  header,
  heroBanner,
  featuredCollection,
  featuredProducts,
  imageWithText,
  richText,
  imageBanner,
  slideshow,
  collectionList,
  newsletter,
  testimonials,
  video,
  logoList,
  multiColumn,
  productGrid,
  contactForm,
  faq,
  footer,
  customHtml,
  separator,
  map,
]);

// ---------------------------------------------------------------------------
// Accessor Functions
// ---------------------------------------------------------------------------

/**
 * Returns all 22 built-in section schemas.
 *
 * @returns A new array containing every built-in section schema.
 *
 * @example
 * ```ts
 * const sections = getBuiltinSections();
 * console.log(sections.length); // 22
 * ```
 */
export function getBuiltinSections(): SectionSchema[] {
  return [...BUILTIN_SECTIONS];
}

/**
 * Looks up a single section schema by its `type` key.
 *
 * @param type - The section type identifier (e.g. `"hero-banner"`).
 * @returns The matching {@link SectionSchema}, or `undefined` if not found.
 *
 * @example
 * ```ts
 * const hero = getSectionByType('hero-banner');
 * if (hero) {
 *   console.log(hero.name); // "Hero Banner"
 * }
 * ```
 */
export function getSectionByType(type: string): SectionSchema | undefined {
  return BUILTIN_SECTIONS.find((s) => s.type === type);
}

/**
 * Returns all sections that belong to a given category.
 *
 * @param category - One of: `header`, `content`, `footer`, `product`,
 *   `marketing`, `media`, or `text`.
 * @returns Array of matching section schemas (may be empty).
 *
 * @example
 * ```ts
 * const productSections = getSectionsByCategory('product');
 * console.log(productSections.map(s => s.type));
 * // ["featured-collection", "featured-products", "collection-list", "product-grid"]
 * ```
 */
export function getSectionsByCategory(category: string): SectionSchema[] {
  return BUILTIN_SECTIONS.filter((s) => s.category === category);
}
